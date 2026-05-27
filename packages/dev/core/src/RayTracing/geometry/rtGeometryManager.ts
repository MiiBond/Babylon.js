import { type WebGPUEngine } from "core/Engines/webgpuEngine";
import { StorageBuffer } from "core/Buffers/storageBuffer";
import { Constants } from "core/Engines/constants";
import { BvhBuilder } from "../bvh/bvhBuilder";
import { BuildTlas, type ITlasInstanceDesc } from "../bvh/tlasBuilder";
import { BvhNodeStride, TriangleStride, TriangleAttribStride, TlasInstanceStride } from "../bvh/bvhTypes";
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

    private _triBufferCapacity = 0; // in triangles
    private _nodeBufferCapacity = 0; // in nodes
    private _instanceBufferCapacity = 0; // in instances

    /** Number of instances uploaded during the last upload() call */
    public instanceCount = 0;

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
        this._triBuffer = null;
        this._attribBuffer = null;
        this._bvhBuffer = null;
        this._tlasBuffer = null;
        this._blasCache.clear();
    }
}
