import { type Scene } from "core/scene";
import { type AbstractMesh } from "core/Meshes/abstractMesh";
import { type Mesh } from "core/Meshes/mesh";
import { VertexBuffer } from "core/Buffers/buffer";
import { Matrix } from "core/Maths/math.vector";
import { CreateTriangleAttribBuffer, TriangleAttribStride } from "../bvh/bvhTypes";

/**
 * Per-mesh geometry ready for BVH construction.
 */
export interface IMeshGeometry {
    /** The source mesh */
    mesh: AbstractMesh;
    /**
     * Flat triangle positions in local space: [v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z, ...]
     * Length = triangleCount × 9
     */
    positions: Float32Array;
    /**
     * Flat triangle normals in local space: [n0x, n0y, n0z, n1x, n1y, n1z, n2x, n2y, n2z, ...]
     * Same indexing as positions.
     */
    normals: Float32Array;
    /**
     * Flat triangle UV0 coordinates: [u0, v0, u1, v1, u2, v2, ...]
     * Length = triangleCount × 6
     */
    uvs: Float32Array;
    /** Number of triangles */
    triangleCount: number;
    /** World-to-local matrix (Float32Array[16], column-major) */
    worldToLocal: Float32Array;
    /** Material index (-1 if none) */
    materialIndex: number;
}

/**
 * A frozen snapshot of the scene's renderable meshes, flattened to triangles.
 * Used to feed the BVH builder and GPU geometry manager.
 */
export interface ISceneSnapshot {
    /**
     *
     */
    meshGeometries: IMeshGeometry[];
}

/**
 * Walks all meshes in the scene and extracts their triangle geometry.
 * Only visible, enabled meshes with at least one triangle are included.
 * @param scene The scene to snapshot
 * @param materialIndexMap Map from material uniqueId to RTMaterial buffer index
 * @returns A snapshot of all eligible mesh geometries
 */
export function SnapshotScene(scene: Scene, materialIndexMap: Map<number, number>): ISceneSnapshot {
    const meshGeometries: IMeshGeometry[] = [];
    const worldToLocalScratch = Matrix.Identity();

    for (const mesh of scene.meshes) {
        if (!mesh.isEnabled() || !mesh.isVisible) {
            continue;
        }
        // Only concrete Meshes (not InstancedMesh etc.) participate in BVH building
        // Instances are handled at the TLAS level
        const concrete = mesh as Mesh;
        if (typeof concrete.getVerticesData !== "function") {
            continue;
        }

        const rawPositions = concrete.getVerticesData(VertexBuffer.PositionKind);
        const indices = concrete.getIndices();
        if (!rawPositions || !indices || indices.length === 0) {
            continue;
        }

        const rawNormals = concrete.getVerticesData(VertexBuffer.NormalKind);
        const rawUVs = concrete.getVerticesData(VertexBuffer.UVKind);

        const triCount = (indices.length / 3) | 0;
        // 9 floats per triangle (tight-packed: v0xyz v1xyz v2xyz) — matches what
        // BvhBuilder expects.  The GPU upload step in RtGeometryManager expands
        // this to 12 floats/tri (vec4f per vertex with 1 float of padding each).
        const posFlat = new Float32Array(triCount * 9);
        const attribFlat = CreateTriangleAttribBuffer(triCount);

        for (let t = 0; t < triCount; t++) {
            const i0 = indices[t * 3 + 0];
            const i1 = indices[t * 3 + 1];
            const i2 = indices[t * 3 + 2];

            const pb = t * 9;
            // positions
            posFlat[pb + 0] = rawPositions[i0 * 3 + 0];
            posFlat[pb + 1] = rawPositions[i0 * 3 + 1];
            posFlat[pb + 2] = rawPositions[i0 * 3 + 2];
            posFlat[pb + 3] = rawPositions[i1 * 3 + 0];
            posFlat[pb + 4] = rawPositions[i1 * 3 + 1];
            posFlat[pb + 5] = rawPositions[i1 * 3 + 2];
            posFlat[pb + 6] = rawPositions[i2 * 3 + 0];
            posFlat[pb + 7] = rawPositions[i2 * 3 + 1];
            posFlat[pb + 8] = rawPositions[i2 * 3 + 2];

            const ab = t * (TriangleAttribStride / 4); // 20 floats per attrib record (80 bytes)
            if (rawNormals) {
                // Slot 0: n0.xyz + pad
                attribFlat[ab + 0] = rawNormals[i0 * 3 + 0];
                attribFlat[ab + 1] = rawNormals[i0 * 3 + 1];
                attribFlat[ab + 2] = rawNormals[i0 * 3 + 2];
                // Slot 1: n1.xyz + pad
                attribFlat[ab + 4] = rawNormals[i1 * 3 + 0];
                attribFlat[ab + 5] = rawNormals[i1 * 3 + 1];
                attribFlat[ab + 6] = rawNormals[i1 * 3 + 2];
                // Slot 2: n2.xyz + pad
                attribFlat[ab + 8] = rawNormals[i2 * 3 + 0];
                attribFlat[ab + 9] = rawNormals[i2 * 3 + 1];
                attribFlat[ab + 10] = rawNormals[i2 * 3 + 2];
            }
            if (rawUVs) {
                // Slot 3: uv0.xy, uv1.xy
                attribFlat[ab + 12] = rawUVs[i0 * 2 + 0];
                attribFlat[ab + 13] = rawUVs[i0 * 2 + 1];
                attribFlat[ab + 14] = rawUVs[i1 * 2 + 0];
                attribFlat[ab + 15] = rawUVs[i1 * 2 + 1];
                // Slot 4: uv2.xy + 2 floats padding
                attribFlat[ab + 16] = rawUVs[i2 * 2 + 0];
                attribFlat[ab + 17] = rawUVs[i2 * 2 + 1];
            }
        }

        // World-to-local
        const worldMatrix = mesh.getWorldMatrix();
        worldMatrix.invertToRef(worldToLocalScratch);
        const wtl = new Float32Array(16);
        worldToLocalScratch.copyToArray(wtl);

        const matUniqueId = mesh.material?.uniqueId ?? -1;
        const materialIndex = matUniqueId >= 0 ? (materialIndexMap.get(matUniqueId) ?? -1) : -1;

        meshGeometries.push({
            mesh,
            positions: posFlat,
            normals: attribFlat,
            uvs: rawUVs ? new Float32Array(rawUVs instanceof Float32Array ? rawUVs.buffer : new Float32Array(rawUVs).buffer) : new Float32Array(triCount * 6),
            triangleCount: triCount,
            worldToLocal: wtl,
            materialIndex,
        });
    }

    return { meshGeometries };
}
