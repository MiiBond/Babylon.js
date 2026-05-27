import { type WebGPUEngine } from "core/Engines/webgpuEngine";
import { StorageBuffer } from "core/Buffers/storageBuffer";
import { Constants } from "core/Engines/constants";
import { BvhBuilder } from "../bvh/bvhBuilder";
import { BuildTlas, type ITlasInstanceDesc } from "../bvh/tlasBuilder";
import { BvhNodeStride, TriangleStride, TriangleAttribStride, TlasInstanceStride, EmissiveTriStride } from "../bvh/bvhTypes";
import { type ISceneSnapshot } from "./rtSceneSnapshot";

/**
 * A cached per-mesh BLAS entry.
 */
interface IBlasCacheEntry {
    /** The packed BVH node data (ArrayBuffer) */
    nodes: ArrayBuffer;
    /** Remapped triangle indices */
    triIndices: Uint32Array;
    nodeCount: number;
    /** Hash of the mesh position data used to detect dirty geometry */
    hash: number;
}

/**
 * Manages all GPU storage buffers required by the ray tracer:
 *  - Triangle position buffer (flat, indexed by geomOffset)
 *  - Triangle attribute buffer (normals + UVs)
 *  - BVH node buffer (all BLASes concatenated)
 *  - TLAS instance buffer
 *
 * Call `upload(snapshot)` once per frame (or whenever the scene changes) to
 * rebuild and upload GPU data.
 */
export class RtGeometryManager {
    private readonly _engine: WebGPUEngine;
    private readonly _builder = new BvhBuilder();

    /** Per-mesh BLAS cache, keyed by mesh uniqueId */
    private readonly _blasCache = new Map<number, IBlasCacheEntry>();

    // GPU buffers — created lazily, recreated if capacity is exceeded
    private _triBuffer: StorageBuffer | null = null;
    private _attribBuffer: StorageBuffer | null = null;
    private _bvhBuffer: StorageBuffer | null = null;
    private _tlasBuffer: StorageBuffer | null = null;
    private _emissiveBuffer: StorageBuffer | null = null;

    private _triBufferCapacity = 0; // in triangles
    private _nodeBufferCapacity = 0; // in nodes
    private _instanceBufferCapacity = 0; // in instances
    private _emissiveBufferCapacity = 0; // in emissive triangles

    /** Number of instances uploaded during the last upload() call */
    public instanceCount = 0;
    /** Number of emissive triangles uploaded during the last uploadEmissive() call */
    public emissiveCount = 0;

    /**
     * Creates a new RtGeometryManager.
     * @param engine - The WebGPU engine used to create storage buffers
     */
    constructor(engine: WebGPUEngine) {
        this._engine = engine;
    }

    /**
     * Returns the GPU storage buffer for triangle positions (readonly from shader side).
     */
    public get triangleBuffer(): StorageBuffer | null {
        return this._triBuffer;
    }

    /**
     * Returns the GPU storage buffer for triangle attributes (normals + UVs).
     */
    public get attribBuffer(): StorageBuffer | null {
        return this._attribBuffer;
    }

    /**
     * Returns the GPU storage buffer containing all BVH nodes.
     */
    public get bvhNodeBuffer(): StorageBuffer | null {
        return this._bvhBuffer;
    }

    /**
     * Returns the GPU storage buffer for TLAS instances.
     */
    public get tlasBuffer(): StorageBuffer | null {
        return this._tlasBuffer;
    }

    /**
     * Returns the GPU storage buffer for emissive triangles (for NEE light sampling).
     * Always non-null after the first `uploadEmissive()` call — contains at least one
     * all-zero sentinel entry so the WebGPU bind group is always complete.
     */
    public get emissiveBuffer(): StorageBuffer | null {
        return this._emissiveBuffer;
    }

    /**
     * Rebuilds BLASes as needed and uploads all geometry to the GPU.
     * Buffers are re-allocated if the scene's triangle/node count grows.
     * @param snapshot Scene snapshot from `snapshotScene()`
     */
    public upload(snapshot: ISceneSnapshot): void {
        const geoms = snapshot.meshGeometries;
        if (geoms.length === 0) {
            this.instanceCount = 0;
            return;
        }

        // --- Step 1: build/retrieve BLASes and measure totals ---
        let totalTris = 0;
        let totalNodes = 0;

        for (const geom of geoms) {
            const meshId = geom.mesh.uniqueId;
            const hash = this._hashPositions(geom.positions);

            let entry = this._blasCache.get(meshId);
            if (!entry || entry.hash !== hash) {
                const blas = this._builder.buildBlas(geom.positions);
                entry = { nodes: blas.nodes, triIndices: blas.triIndices, nodeCount: blas.nodeCount, hash };
                this._blasCache.set(meshId, entry);
            }

            totalTris += geom.triangleCount;
            totalNodes += entry.nodeCount;
        }

        // --- Step 2: ensure GPU buffers are large enough ---
        this._ensureTriBuffer(totalTris);
        this._ensureNodeBuffer(totalNodes);
        this._ensureInstanceBuffer(geoms.length);

        // --- Step 3: pack and upload triangle + attrib data, build TLAS instances ---
        const triPosStride = TriangleStride / 4; // floats
        const attribStride = TriangleAttribStride / 4;

        const triPosFlat = new Float32Array(totalTris * triPosStride);
        const attribFlat = new Float32Array(totalTris * attribStride);
        const allNodes = new Uint8Array(totalNodes * BvhNodeStride);

        const tlasInstances: ITlasInstanceDesc[] = [];

        let triOffset = 0; // in triangles
        let nodeByteOffset = 0; // in bytes

        for (const geom of geoms) {
            const entry = this._blasCache.get(geom.mesh.uniqueId)!;

            // Upload triangles in the order the BVH expects — entry.triIndices[t] maps
            // BVH-sorted slot t back to the original triangle index in geom.positions/normals.
            // BVH leaf nodes store firstTri as an index INTO the sorted array, so the GPU
            // buffers must match that same order.  Using the original order here (t directly)
            // would make every leaf point at the wrong triangles.
            for (let t = 0; t < geom.triangleCount; t++) {
                const origT = entry.triIndices[t]; // original triangle index
                const s = origT * 9; // source position: 9 floats/tri
                const d = (triOffset + t) * triPosStride; // dest: 12 floats/tri (vec4f stride)

                triPosFlat[d + 0] = geom.positions[s + 0]; // v0.x
                triPosFlat[d + 1] = geom.positions[s + 1]; // v0.y
                triPosFlat[d + 2] = geom.positions[s + 2]; // v0.z
                // d+3 = padding (zero)
                triPosFlat[d + 4] = geom.positions[s + 3]; // v1.x
                triPosFlat[d + 5] = geom.positions[s + 4]; // v1.y
                triPosFlat[d + 6] = geom.positions[s + 5]; // v1.z
                // d+7 = padding
                triPosFlat[d + 8] = geom.positions[s + 6]; // v2.x
                triPosFlat[d + 9] = geom.positions[s + 7]; // v2.y
                triPosFlat[d + 10] = geom.positions[s + 8]; // v2.z
                // d+11 = padding

                // Remap attribs (normals + UVs) with the same permutation.
                // geom.normals is already in GPU attrib layout (16 floats/tri).
                const srcA = origT * attribStride;
                const dstA = (triOffset + t) * attribStride;
                for (let f = 0; f < attribStride; f++) {
                    attribFlat[dstA + f] = geom.normals[srcA + f];
                }
            }

            // Copy BVH nodes
            allNodes.set(new Uint8Array(entry.nodes), nodeByteOffset);

            // Build TLAS instance
            tlasInstances.push({
                worldToLocal: geom.worldToLocal,
                blasByteOffset: nodeByteOffset,
                geomOffset: triOffset,
                materialIndex: geom.materialIndex >= 0 ? geom.materialIndex : 0,
            });

            triOffset += geom.triangleCount;
            nodeByteOffset += entry.nodeCount * BvhNodeStride;
        }

        // --- Step 4: upload to GPU ---
        this._triBuffer!.update(triPosFlat);
        this._attribBuffer!.update(attribFlat);
        this._bvhBuffer!.update(allNodes);

        const tlasData = BuildTlas(tlasInstances);
        this._tlasBuffer!.update(new Uint8Array(tlasData));

        this.instanceCount = geoms.length;
    }

    /**
     * Builds and uploads the emissive triangle list used for Next Event Estimation.
     * Must be called after `upload()` so the BLAS cache is current.
     *
     * Each entry in `meshEmissiveLe` corresponds to the same index in
     * `snapshot.meshGeometries`: provide `null` for non-emissive meshes, or a
     * `[r, g, b]` triple (emissionColor × emissionLuminance) for emissive ones.
     *
     * Triangles are stored in world space so the shader can sample them directly
     * without needing the per-instance inverse matrix.  The buffer always contains
     * at least one sentinel entry so the WebGPU bind group is never empty.
     *
     * @param snapshot Scene snapshot from the matching `upload()` call
     * @param meshEmissiveLe Per-mesh emitted radiance, or null for non-emissive meshes
     */
    public uploadEmissive(snapshot: ISceneSnapshot, meshEmissiveLe: Array<[number, number, number] | null>): void {
        const geoms = snapshot.meshGeometries;
        // 16 floats per EmissiveTri (4 × vec4f = 64 bytes)
        const floatsPerEntry = EmissiveTriStride / 4;

        // Two-pass: first count, then fill — avoids a growing array.
        let count = 0;
        for (let meshIdx = 0; meshIdx < geoms.length; meshIdx++) {
            if (!meshEmissiveLe[meshIdx]) {
                continue;
            }
            const geom = geoms[meshIdx];
            const entry = this._blasCache.get(geom.mesh.uniqueId);
            if (entry) {
                count += geom.triangleCount;
            }
        }

        // Always allocate at least 1 sentinel entry (all zeros) so the bind group
        // is valid even when emissiveCount == 0.
        const alloc = Math.max(count, 1);
        this._ensureEmissiveBuffer(alloc);
        const flat = new Float32Array(alloc * floatsPerEntry); // zero-init by default

        let outIdx = 0;
        for (let meshIdx = 0; meshIdx < geoms.length; meshIdx++) {
            const le = meshEmissiveLe[meshIdx];
            if (!le) {
                continue;
            }
            const geom = geoms[meshIdx];
            const entry = this._blasCache.get(geom.mesh.uniqueId);
            if (!entry) {
                continue;
            }

            // Grab the column-major world matrix from the mesh.
            const m = geom.mesh.getWorldMatrix().m;

            for (let t = 0; t < geom.triangleCount; t++) {
                const origT = entry.triIndices[t]; // BVH-sorted slot → original triangle
                const s = origT * 9;

                // Transform local vertices to world space (no allocation).
                const lx0 = geom.positions[s + 0];
                const ly0 = geom.positions[s + 1];
                const lz0 = geom.positions[s + 2];
                const lx1 = geom.positions[s + 3];
                const ly1 = geom.positions[s + 4];
                const lz1 = geom.positions[s + 5];
                const lx2 = geom.positions[s + 6];
                const ly2 = geom.positions[s + 7];
                const lz2 = geom.positions[s + 8];

                // BJS Matrix is column-major: m[0..3] = col0, m[4..7] = col1, ...
                // Point transform: wx = m[0]*lx + m[4]*ly + m[8]*lz + m[12]
                const wx0 = m[0] * lx0 + m[4] * ly0 + m[8] * lz0 + m[12];
                const wy0 = m[1] * lx0 + m[5] * ly0 + m[9] * lz0 + m[13];
                const wz0 = m[2] * lx0 + m[6] * ly0 + m[10] * lz0 + m[14];

                const wx1 = m[0] * lx1 + m[4] * ly1 + m[8] * lz1 + m[12];
                const wy1 = m[1] * lx1 + m[5] * ly1 + m[9] * lz1 + m[13];
                const wz1 = m[2] * lx1 + m[6] * ly1 + m[10] * lz1 + m[14];

                const wx2 = m[0] * lx2 + m[4] * ly2 + m[8] * lz2 + m[12];
                const wy2 = m[1] * lx2 + m[5] * ly2 + m[9] * lz2 + m[13];
                const wz2 = m[2] * lx2 + m[6] * ly2 + m[10] * lz2 + m[14];

                // World-space area = 0.5 × |cross(e1, e2)|
                const e1x = wx1 - wx0;
                const e1y = wy1 - wy0;
                const e1z = wz1 - wz0;
                const e2x = wx2 - wx0;
                const e2y = wy2 - wy0;
                const e2z = wz2 - wz0;
                const cx = e1y * e2z - e1z * e2y;
                const cy = e1z * e2x - e1x * e2z;
                const cz = e1x * e2y - e1y * e2x;
                const area = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);

                if (area < 1e-12) {
                    continue; // degenerate triangle — skip without advancing outIdx
                }

                const base = outIdx * floatsPerEntry;
                flat[base + 0] = wx0;
                flat[base + 1] = wy0;
                flat[base + 2] = wz0;
                flat[base + 3] = meshIdx; // TLAS instance index — used by shadow ray to skip self-occlusion
                flat[base + 4] = wx1;
                flat[base + 5] = wy1;
                flat[base + 6] = wz1;
                flat[base + 7] = 0;
                flat[base + 8] = wx2;
                flat[base + 9] = wy2;
                flat[base + 10] = wz2;
                flat[base + 11] = 0;
                flat[base + 12] = le[0]; // emitted radiance R
                flat[base + 13] = le[1]; // emitted radiance G
                flat[base + 14] = le[2]; // emitted radiance B
                flat[base + 15] = area;

                outIdx++;
            }
        }

        this.emissiveCount = outIdx;
        this._emissiveBuffer!.update(flat);
    }

    // ---- Private helpers ----------------------------------------------------

    private _ensureTriBuffer(triCount: number): void {
        if (triCount <= this._triBufferCapacity) {
            return;
        }
        this._triBuffer?.dispose();
        this._attribBuffer?.dispose();
        // Allocate with 50% headroom to avoid frequent reallocations
        const capacity = Math.ceil(triCount * 1.5);
        this._triBuffer = new StorageBuffer(this._engine, capacity * TriangleStride, Constants.BUFFER_CREATIONFLAG_READWRITE, "rt_triangles");
        this._attribBuffer = new StorageBuffer(this._engine, capacity * TriangleAttribStride, Constants.BUFFER_CREATIONFLAG_READWRITE, "rt_attribs");
        this._triBufferCapacity = capacity;
    }

    private _ensureNodeBuffer(nodeCount: number): void {
        if (nodeCount <= this._nodeBufferCapacity) {
            return;
        }
        this._bvhBuffer?.dispose();
        const capacity = Math.ceil(nodeCount * 1.5);
        this._bvhBuffer = new StorageBuffer(this._engine, capacity * BvhNodeStride, Constants.BUFFER_CREATIONFLAG_READWRITE, "rt_bvh_nodes");
        this._nodeBufferCapacity = capacity;
    }

    private _ensureInstanceBuffer(instanceCount: number): void {
        if (instanceCount <= this._instanceBufferCapacity) {
            return;
        }
        this._tlasBuffer?.dispose();
        const capacity = Math.ceil(instanceCount * 1.5);
        this._tlasBuffer = new StorageBuffer(this._engine, capacity * TlasInstanceStride, Constants.BUFFER_CREATIONFLAG_READWRITE, "rt_tlas");
        this._instanceBufferCapacity = capacity;
    }

    private _ensureEmissiveBuffer(count: number): void {
        if (count <= this._emissiveBufferCapacity) {
            return;
        }
        this._emissiveBuffer?.dispose();
        const capacity = Math.ceil(count * 1.5);
        this._emissiveBuffer = new StorageBuffer(this._engine, capacity * EmissiveTriStride, Constants.BUFFER_CREATIONFLAG_READWRITE, "rt_emissive_tris");
        this._emissiveBufferCapacity = capacity;
    }

    /**
     * Quick rolling hash of vertex positions to detect dirty geometry.
     * Not cryptographic — just fast change detection.
     * @param positions Float32Array of triangle vertex positions
     * @returns 32-bit hash value
     */
    private _hashPositions(positions: Float32Array): number {
        let h = 0x811c9dc5;
        const u32 = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);
        for (let i = 0; i < u32.length; i++) {
            h ^= u32[i];
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h;
    }

    /**
     * Releases all GPU buffers and clears the BLAS cache.
     */
    public dispose(): void {
        this._triBuffer?.dispose();
        this._attribBuffer?.dispose();
        this._bvhBuffer?.dispose();
        this._tlasBuffer?.dispose();
        this._emissiveBuffer?.dispose();
        this._triBuffer = null;
        this._attribBuffer = null;
        this._bvhBuffer = null;
        this._tlasBuffer = null;
        this._emissiveBuffer = null;
        this._blasCache.clear();
    }
}
