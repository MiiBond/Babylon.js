import { BvhNodeStride, CreateBvhBuffer } from "./bvhTypes";

/**
 * A built BLAS (Bottom-Level Acceleration Structure) ready for GPU upload.
 */
export interface IBlas {
    /**
     * Flat array of BVH nodes in GPU-ready layout (32 bytes / node).
     * Interleaved float/uint: written via CreateBvhBuffer() views.
     */
    readonly nodes: ArrayBuffer;
    /**
     * Remapped triangle indices — `triIndices[i]` is the original triangle
     * index in the input position array for the i-th triangle in leaf order.
     */
    readonly triIndices: Uint32Array;
    /** Total number of BVH nodes (root is always node 0) */
    readonly nodeCount: number;
}

// ---- Internal helpers -------------------------------------------------------

/** Axis-aligned bounding box used internally during BVH construction */
interface IAabb {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
}

function MakeEmptyAabb(): IAabb {
    return { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
}

function GrowAabb(box: IAabb, x: number, y: number, z: number): void {
    if (x < box.minX) {
        box.minX = x;
    }
    if (y < box.minY) {
        box.minY = y;
    }
    if (z < box.minZ) {
        box.minZ = z;
    }
    if (x > box.maxX) {
        box.maxX = x;
    }
    if (y > box.maxY) {
        box.maxY = y;
    }
    if (z > box.maxZ) {
        box.maxZ = z;
    }
}

function AabbSurfaceArea(box: IAabb): number {
    const dx = box.maxX - box.minX;
    const dy = box.maxY - box.minY;
    const dz = box.maxZ - box.minZ;
    return 2.0 * (dx * dy + dy * dz + dz * dx);
}

function MergeAabb(a: IAabb, b: IAabb): IAabb {
    return {
        minX: Math.min(a.minX, b.minX),
        minY: Math.min(a.minY, b.minY),
        minZ: Math.min(a.minZ, b.minZ),
        maxX: Math.max(a.maxX, b.maxX),
        maxY: Math.max(a.maxY, b.maxY),
        maxZ: Math.max(a.maxZ, b.maxZ),
    };
}

/** Number of SAH bins per axis */
const SahBins = 8;
/** Maximum triangles per leaf before we force a split */
const MaxLeafTris = 4;
/** Relative cost of a triangle intersection vs. a bounding-box test */
const SahTriCost = 1.0;

interface IBinEntry {
    count: number;
    box: IAabb;
}

// ---- Build state ------------------------------------------------------------

/** Mutable work-in-progress BVH node (converted to flat layout at end) */
interface IBuildNode {
    aabb: IAabb;
    leftChild: number; // index into _nodes; -1 for leaves
    rightChild: number;
    firstTri: number; // index into _triIndices
    triCount: number;
}

/** BVH builder — call buildBlas() to construct a BLAS from triangle positions */
export class BvhBuilder {
    private _nodes: IBuildNode[] = [];
    private _triIndices: Uint32Array = new Uint32Array(0);
    // Per-triangle centroid cache
    private _centroids: Float32Array = new Float32Array(0);

    /**
     * Builds a BLAS from flat vertex positions.
     * @param positions Flat array of vertex positions: [x0,y0,z0, x1,y1,z1, ...]
     *   Length must be `triangleCount * 9` (3 vertices × 3 floats each).
     * @returns The finished BLAS ready for GPU upload.
     */
    public buildBlas(positions: Float32Array): IBlas {
        const triCount = (positions.length / 9) | 0;
        if (triCount === 0) {
            // Empty mesh — return a single leaf node covering nothing
            const { buffer } = CreateBvhBuffer(1);
            return { nodes: buffer, triIndices: new Uint32Array(0), nodeCount: 1 };
        }

        // Initialise index and centroid arrays
        this._triIndices = new Uint32Array(triCount);
        this._centroids = new Float32Array(triCount * 3);
        for (let i = 0; i < triCount; i++) {
            this._triIndices[i] = i;
            const base = i * 9;
            this._centroids[i * 3 + 0] = (positions[base + 0] + positions[base + 3] + positions[base + 6]) / 3;
            this._centroids[i * 3 + 1] = (positions[base + 1] + positions[base + 4] + positions[base + 7]) / 3;
            this._centroids[i * 3 + 2] = (positions[base + 2] + positions[base + 5] + positions[base + 8]) / 3;
        }

        this._nodes = [];
        // Build root
        const rootAABB = this._computeAabbForRange(positions, 0, triCount);
        this._nodes.push({ aabb: rootAABB, leftChild: -1, rightChild: -1, firstTri: 0, triCount });
        this._subdivide(0, positions);

        return this._packToGpu();
    }

    // ---- Recursive subdivision ----------------------------------------------

    private _subdivide(nodeIdx: number, positions: Float32Array): void {
        const node = this._nodes[nodeIdx];
        if (node.triCount <= MaxLeafTris) {
            return; // Already a small enough leaf
        }

        const split = this._findBestSplit(node, positions);
        if (split === null) {
            return; // SAH says leaf is cheaper
        }

        const { axis, splitPos } = split;

        // Partition triIndices around split plane (in-place)
        let left = node.firstTri;
        let right = node.firstTri + node.triCount - 1;
        while (left <= right) {
            if (this._centroids[this._triIndices[left] * 3 + axis] < splitPos) {
                left++;
            } else {
                // Swap
                const tmp = this._triIndices[left];
                this._triIndices[left] = this._triIndices[right];
                this._triIndices[right] = tmp;
                right--;
            }
        }

        const leftCount = left - node.firstTri;
        if (leftCount === 0 || leftCount === node.triCount) {
            return; // Degenerate split → keep as leaf
        }

        // Create child nodes
        const leftIdx = this._nodes.length;
        const rightIdx = leftIdx + 1;
        node.leftChild = leftIdx;
        node.rightChild = rightIdx;

        const leftAabb = this._computeAabbForRange(positions, node.firstTri, leftCount);
        const rightAabb = this._computeAabbForRange(positions, node.firstTri + leftCount, node.triCount - leftCount);

        this._nodes.push({ aabb: leftAabb, leftChild: -1, rightChild: -1, firstTri: node.firstTri, triCount: leftCount });
        this._nodes.push({ aabb: rightAabb, leftChild: -1, rightChild: -1, firstTri: node.firstTri + leftCount, triCount: node.triCount - leftCount });

        // Clear interior node's tri fields
        node.triCount = 0;

        this._subdivide(leftIdx, positions);
        this._subdivide(rightIdx, positions);
    }

    /**
     * Finds the best SAH split for a node using binned SAH.
     * @param node The build node to split
     * @param positions Flat triangle position array
     * @returns The best split axis and position, or null if the leaf is cheaper
     */
    private _findBestSplit(node: IBuildNode, positions: Float32Array): { axis: number; splitPos: number } | null {
        let bestCost = Infinity;
        let bestAxis = -1;
        let bestSplit = 0;

        const parentSA = AabbSurfaceArea(node.aabb);
        const leafCost = node.triCount * SahTriCost;

        for (let axis = 0; axis < 3; axis++) {
            // Find centroid extents along this axis
            let cMin = Infinity;
            let cMax = -Infinity;
            for (let i = 0; i < node.triCount; i++) {
                const c = this._centroids[this._triIndices[node.firstTri + i] * 3 + axis];
                if (c < cMin) {
                    cMin = c;
                }
                if (c > cMax) {
                    cMax = c;
                }
            }
            if (cMin === cMax) {
                continue;
            }

            const binSize = (cMax - cMin) / SahBins;
            const invBinSize = 1.0 / binSize;

            // Initialize bins
            const bins: IBinEntry[] = [];
            for (let b = 0; b < SahBins; b++) {
                bins.push({ count: 0, box: MakeEmptyAabb() });
            }

            // Assign triangles to bins
            for (let i = 0; i < node.triCount; i++) {
                const triIdx = this._triIndices[node.firstTri + i];
                const c = this._centroids[triIdx * 3 + axis];
                let b = ((c - cMin) * invBinSize) | 0;
                if (b >= SahBins) {
                    b = SahBins - 1;
                }
                bins[b].count++;
                // Grow bin AABB with triangle vertices
                const vBase = triIdx * 9;
                for (let v = 0; v < 3; v++) {
                    GrowAabb(bins[b].box, positions[vBase + v * 3], positions[vBase + v * 3 + 1], positions[vBase + v * 3 + 2]);
                }
            }

            // Sweep left-to-right to evaluate SAH at each split plane
            const leftCounts = new Int32Array(SahBins - 1);
            const leftBoxes: IAabb[] = [];
            {
                let runBox = MakeEmptyAabb();
                let runCount = 0;
                for (let b = 0; b < SahBins - 1; b++) {
                    runCount += bins[b].count;
                    runBox = MergeAabb(runBox, bins[b].box);
                    leftCounts[b] = runCount;
                    leftBoxes.push({ ...runBox });
                }
            }

            const rightCounts = new Int32Array(SahBins - 1);
            const rightBoxes: IAabb[] = new Array(SahBins - 1);
            {
                let runBox = MakeEmptyAabb();
                let runCount = 0;
                for (let b = SahBins - 2; b >= 0; b--) {
                    runCount += bins[b + 1].count;
                    runBox = MergeAabb(runBox, bins[b + 1].box);
                    rightCounts[b] = runCount;
                    rightBoxes[b] = { ...runBox };
                }
            }

            for (let b = 0; b < SahBins - 1; b++) {
                const lc = leftCounts[b];
                const rc = rightCounts[b];
                if (lc === 0 || rc === 0) {
                    continue;
                }
                const cost = ((AabbSurfaceArea(leftBoxes[b]) * lc + AabbSurfaceArea(rightBoxes[b]) * rc) / parentSA) * SahTriCost;
                if (cost < bestCost) {
                    bestCost = cost;
                    bestAxis = axis;
                    bestSplit = cMin + (b + 1) * binSize;
                }
            }
        }

        if (bestAxis === -1 || bestCost >= leafCost) {
            return null;
        }

        return { axis: bestAxis, splitPos: bestSplit };
    }

    // ---- AABB helpers -------------------------------------------------------

    private _computeAabbForRange(positions: Float32Array, firstTri: number, triCount: number): IAabb {
        const box = MakeEmptyAabb();
        for (let i = 0; i < triCount; i++) {
            const triIdx = this._triIndices[firstTri + i];
            const base = triIdx * 9;
            for (let v = 0; v < 3; v++) {
                GrowAabb(box, positions[base + v * 3], positions[base + v * 3 + 1], positions[base + v * 3 + 2]);
            }
        }
        return box;
    }

    // ---- GPU packing --------------------------------------------------------

    private _packToGpu(): IBlas {
        const nodeCount = this._nodes.length;
        const { buffer, f32, u32 } = CreateBvhBuffer(nodeCount);
        const stride = BvhNodeStride / 4; // floats per node

        for (let i = 0; i < nodeCount; i++) {
            const node = this._nodes[i];
            const base = i * stride;
            f32[base + 0] = node.aabb.minX;
            f32[base + 1] = node.aabb.minY;
            f32[base + 2] = node.aabb.minZ;
            u32[base + 3] = node.leftChild >= 0 ? node.leftChild : node.firstTri;
            f32[base + 4] = node.aabb.maxX;
            f32[base + 5] = node.aabb.maxY;
            f32[base + 6] = node.aabb.maxZ;
            u32[base + 7] = node.triCount; // 0 for interior nodes
        }

        return { nodes: buffer, triIndices: this._triIndices.slice(), nodeCount };
    }
}
