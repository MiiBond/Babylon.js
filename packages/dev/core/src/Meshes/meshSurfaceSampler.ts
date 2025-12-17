import type { Scene } from "../scene";
import { Vector2, Vector3, Vector4 } from "../Maths/math.vector";
import { VertexBuffer } from "../Buffers/buffer";
import type { Mesh } from "./mesh";
import { MeshBuilder } from "./meshBuilder";
import { Logger } from "../Misc/logger";
import type { Nullable } from "core/types";

/**
 * Vose's Alias Method implementation for fast weighted sampling
 * Allows O(1) sampling after O(n) preprocessing
 */
class AliasMethod {
    private _small: Array<{ bucketIndex: number; probability: number }> = [];
    private _large: Array<{ bucketIndex: number; probability: number }> = [];

    /**
     * Build probability and alias tables from unnormalized PMF data
     * @param pmfData Unnormalized probability masses (e.g., triangle areas)
     * @returns Total mass for normalization
     */
    buildProbAndAliasTables(pmfData: number[]): { probAndAliasTables: number[]; totalMass: number } {
        this._small = [];
        this._large = [];

        const numElements = pmfData.length;
        let totalMass = 0;

        // Step 1: Calculate total mass
        for (let i = 0; i < numElements; i++) {
            totalMass += pmfData[i];
        }

        if (totalMass <= 0) {
            // Edge case: no valid probability masses
            return {
                probAndAliasTables: Array(numElements * 2).fill(0),
                totalMass: 0,
            };
        }

        // Step 2: Normalize and scale by n, then split into small/large stacks
        const scale = numElements / totalMass;
        for (let i = 0; i < numElements; i++) {
            const scaledProbability = pmfData[i] * scale;
            if (scaledProbability < 1.0) {
                this._small.push({ bucketIndex: i, probability: scaledProbability });
            } else {
                this._large.push({ bucketIndex: i, probability: scaledProbability });
            }
        }

        // Step 3: Build prob and alias tables
        const probAndAliasTables = new Array(numElements * 2);

        while (this._small.length > 0 && this._large.length > 0) {
            const topSmall = this._small.pop()!;
            const topLarge = this._large.pop()!;

            // Set probability and alias for small bucket
            probAndAliasTables[topSmall.bucketIndex * 2] = topSmall.probability;
            probAndAliasTables[topSmall.bucketIndex * 2 + 1] = topLarge.bucketIndex;

            // Adjust large bucket
            topLarge.probability = topLarge.probability + topSmall.probability - 1.0;

            if (topLarge.probability < 1.0) {
                this._small.push(topLarge);
            } else {
                this._large.push(topLarge);
            }
        }

        // Step 4: Handle remaining elements
        while (this._large.length > 0) {
            const topLarge = this._large.pop()!;
            probAndAliasTables[topLarge.bucketIndex * 2] = 1.0;
            probAndAliasTables[topLarge.bucketIndex * 2 + 1] = topLarge.bucketIndex;
        }

        while (this._small.length > 0) {
            const topSmall = this._small.pop()!;
            probAndAliasTables[topSmall.bucketIndex * 2] = 1.0;
            probAndAliasTables[topSmall.bucketIndex * 2 + 1] = topSmall.bucketIndex;
        }

        return { probAndAliasTables, totalMass };
    }
}

/**
 * 1D Probability Mass Function for sampling
 */
class Pmf1d {
    private _pmfData: number[];
    private _probAndAliasTables: number[] = [];
    private _usable: boolean = false;

    constructor(width: number) {
        this._pmfData = Array(width).fill(0);
    }

    setUnnormalizedProbabilityMass(index: number, mass: number): void {
        if (index < 0 || index >= this._pmfData.length) {
            throw new Error(`Index ${index} out of bounds`);
        }
        this._pmfData[index] = mass;
    }

    normalizeAndCreateTables(): void {
        if (this._usable) {
            throw new Error("PMF already normalized");
        }

        const aliasMethod = new AliasMethod();
        const { probAndAliasTables, totalMass } = aliasMethod.buildProbAndAliasTables(this._pmfData);

        this._probAndAliasTables = probAndAliasTables;

        if (totalMass > 0) {
            const inverseTotalMass = 1.0 / totalMass;
            for (let i = 0; i < this._pmfData.length; i++) {
                this._pmfData[i] *= inverseTotalMass;
            }
            this._usable = true;
        }
    }

    isUsable(): boolean {
        return this._usable;
    }

    /**
     * Sample from the PMF in O(1) time
     * @param rand Random value in [0, 1)
     * @returns Sampled index
     */
    sample(rand: number): number {
        if (!this._usable) {
            throw new Error("PMF not usable - call normalizeAndCreateTables() first");
        }

        if (rand < 0 || rand >= 1.0) {
            throw new Error(`Random value must be in [0, 1), got ${rand}`);
        }

        const width = this._pmfData.length;
        const exactBucketIndex = width * rand;
        const bucketIndex = Math.floor(exactBucketIndex);

        // Remap random for reuse
        rand = exactBucketIndex - bucketIndex;

        const prob = this._probAndAliasTables[bucketIndex * 2];
        const alias = this._probAndAliasTables[bucketIndex * 2 + 1];

        if (rand < prob) {
            return bucketIndex;
        } else {
            return alias;
        }
    }

    getProbability(index: number): number {
        if (!this._usable) {
            throw new Error("PMF not usable");
        }
        return this._pmfData[index];
    }
}

/**
 * Permuted Congruential Generator
 * random number generator for deterministic sampling
 */
// class RandomNumberGeneratorPcg {
//     private _state: bigint;

//     constructor(seed: number = 0) {
//         // Properly initialize the state - avoid starting with 0
//         this._state = BigInt(seed === 0 ? 1 : seed);

//         // Run a few iterations to get into a good state
//         for (let i = 0; i < 10; i++) {
//             this._next();
//         }
//     }

//     private _next(): number {
//         const oldstate = this._state;
//         // Use BigInt constructor instead of hex literal
//         this._state = (oldstate * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);

//         const xorshifted = Number((oldstate >> 18n) ^ oldstate) >>> 27;
//         const rot = Number(oldstate >> 59n) & 31;

//         // Proper circular rotation
//         const result = (xorshifted >>> rot) | (xorshifted << (-rot & 31));
//         return result >>> 0;
//     }

//     nextFloat(): number {
//         return this._next() / 4294967296.0; // 2^32
//     }
// }

class SimpleRng {
    private _seed: number;

    constructor(seed: number = 0) {
        this._seed = seed === 0 ? 1 : seed;
    }

    nextFloat(): number {
        this._seed = (this._seed * 1664525 + 1013904223) >>> 0;
        return this._seed / 4294967296.0;
    }
}

/**
 * Result of fiber root position generation
 */
export interface ISurfaceSamplingData {
    positions: Vector3[];
    normals: Vector3[];
    seeds: number[];
    triangleIndices: number[];
    barycentricCoords: Vector3[];
    tangents?: Vector4[];
    uvs?: Vector2[];
    uvs2?: Vector2[];
}

/**
 * Generates fiber root positions on a js mesh using PMF-weighted triangle sampling
 */
export class MeshSurfaceSampler {
    private _mesh: Mesh;
    private _pmf: Pmf1d | null = null;
    private _totalArea: number = 0;

    constructor(mesh: Mesh) {
        this._mesh = mesh;
    }

    /**
     * Precompute PMF data for the mesh (call once, then reuse for multiple samplings)
     */
    preprocessMesh(): void {
        const positions = this._mesh.getVerticesData(VertexBuffer.PositionKind);
        const indices = this._mesh.getIndices();

        if (!positions || !indices) {
            throw new Error("Mesh must have position and index data");
        }

        const triangleCount = indices.length / 3;
        this._pmf = new Pmf1d(triangleCount);
        this._totalArea = 0;

        // Get world space transform
        // const worldMatrix = this._mesh.getWorldMatrix();

        // Compute triangle areas
        for (let i = 0; i < triangleCount; i++) {
            const i0 = indices[i * 3];
            const i1 = indices[i * 3 + 1];
            const i2 = indices[i * 3 + 2];

            const v0 = Vector3.FromArray(positions, i0 * 3);
            const v1 = Vector3.FromArray(positions, i1 * 3);
            const v2 = Vector3.FromArray(positions, i2 * 3);

            // Transform to world space
            // const v0WorldSpace = Vector3.TransformCoordinates(v0, worldMatrix);
            // const v1WorldSpace = Vector3.TransformCoordinates(v1, worldMatrix);
            // const v2WorldSpace = Vector3.TransformCoordinates(v2, worldMatrix);

            // Compute triangle area using cross product
            const e0 = v1.subtract(v0);
            const e1 = v2.subtract(v0);
            const crossProduct = Vector3.Cross(e0, e1);
            const area = crossProduct.length() * 0.5;

            this._pmf.setUnnormalizedProbabilityMass(i, area);
            this._totalArea += area;
        }

        // Build PMF tables
        this._pmf.normalizeAndCreateTables();

        if (!this._pmf.isUsable()) {
            throw new Error("Failed to build PMF tables");
        }
    }

    /**
     * Sample a random point on the mesh surface using barycentric interpolation
     * @param seed Random seed for reproducibility
     * @param rng Random number generator for sampling
     * @returns Fiber root position data
     */
    generateSurfaceSample(seed: number = 0, rng: Nullable<SimpleRng> = null): ISurfaceSamplingData {
        if (!this._pmf || !this._pmf.isUsable()) {
            throw new Error("Must call preprocessMesh() before sampling");
        }

        const positions = this._mesh.getVerticesData(VertexBuffer.PositionKind);
        const normals = this._mesh.getVerticesData(VertexBuffer.NormalKind);
        const uvs = this._mesh.getVerticesData(VertexBuffer.UVKind);
        const uvs2 = this._mesh.getVerticesData(VertexBuffer.UV2Kind);
        const tangents = this._mesh.getVerticesData(VertexBuffer.TangentKind);
        const indices = this._mesh.getIndices();

        if (!positions || !indices) {
            throw new Error("Mesh must have position and index data");
        }

        if (!rng) {
            rng = new SimpleRng(seed);
        }
        const scaling = this._mesh.scaling;

        // Step 1: Sample triangle using PMF
        const triangleIndex = this._pmf.sample(rng.nextFloat());
        // const triangleIndex = this._pmf.sample(Math.random());

        // Step 2: Get triangle vertices
        const i0 = indices[triangleIndex * 3];
        const i1 = indices[triangleIndex * 3 + 1];
        const i2 = indices[triangleIndex * 3 + 2];

        const v0 = Vector3.FromArray(positions, i0 * 3);
        const v1 = Vector3.FromArray(positions, i1 * 3);
        const v2 = Vector3.FromArray(positions, i2 * 3);

        // Step 3: Generate random barycentric coordinates (uniform triangle sampling - Heitz method)
        const bary = this._sampleUnitTriangle(rng.nextFloat(), rng.nextFloat());
        // Logger.Log("Baycentric coords: " + bary.toString());
        // const bary = this._sampleUnitTriangle(Math.random(), Math.random());

        // Step 4: Interpolate root position
        const localPosition = v0.scale(bary.x).add(v1.scale(bary.y)).add(v2.scale(bary.z));
        const scaledPosition = localPosition.multiply(scaling);

        // Step 5: Interpolate normal (if available)
        let interpolatedNormal = Vector3.Up();
        if (normals) {
            const n0 = Vector3.FromArray(normals, i0 * 3);
            const n1 = Vector3.FromArray(normals, i1 * 3);
            const n2 = Vector3.FromArray(normals, i2 * 3);

            const localNormal = n0.scale(bary.x).add(n1.scale(bary.y)).add(n2.scale(bary.z));
            // TODO: Handle non-uniform scaling
            interpolatedNormal = localNormal.normalize();
        }

        // Step 6: (Optional) Interpolate UVs, tangents if needed for further processing
        let interpolatedUV = Vector2.Zero();
        if (uvs) {
            const uv0 = Vector2.FromArray(uvs, i0 * 2);
            const uv1 = Vector2.FromArray(uvs, i1 * 2);
            const uv2 = Vector2.FromArray(uvs, i2 * 2);

            interpolatedUV = uv0.scale(bary.x).add(uv1.scale(bary.y)).add(uv2.scale(bary.z));
        }

        let interpolatedUV2 = Vector2.Zero();
        if (uvs2) {
            const uv20 = Vector2.FromArray(uvs2, i0 * 2);
            const uv21 = Vector2.FromArray(uvs2, i1 * 2);
            const uv22 = Vector2.FromArray(uvs2, i2 * 2);

            interpolatedUV2 = uv20.scale(bary.x).add(uv21.scale(bary.y)).add(uv22.scale(bary.z));
        }

        let interpolatedTangent = null;
        if (tangents) {
            const t0 = Vector4.FromArray(tangents, i0 * 4);
            const t1 = Vector4.FromArray(tangents, i1 * 4);
            const t2 = Vector4.FromArray(tangents, i2 * 4);

            interpolatedTangent = t0.scale(bary.x).add(t1.scale(bary.y)).add(t2.scale(bary.z));
            interpolatedTangent.normalize();
        } else if (uvs) {
            // Determine tangent from UVs if tangents not available
            const deltaPos1 = v1.subtract(v0);
            const deltaPos2 = v2.subtract(v0);
            const deltaUV1 = Vector3.FromArray(uvs, i1 * 2).subtract(Vector3.FromArray(uvs, i0 * 2));
            const deltaUV2 = Vector3.FromArray(uvs, i2 * 2).subtract(Vector3.FromArray(uvs, i0 * 2));

            const r = 1.0 / (deltaUV1.x * deltaUV2.y - deltaUV1.y * deltaUV2.x);
            const tangent = deltaPos1.scale(deltaUV2.y).subtract(deltaPos2.scale(deltaUV1.y)).scale(r);
            interpolatedTangent = new Vector4(tangent.x, tangent.y, tangent.z, 1.0).normalize();
        }

        return {
            positions: [localPosition],
            normals: [interpolatedNormal],
            seeds: [seed],
            triangleIndices: [triangleIndex],
            barycentricCoords: [bary],
            uvs: interpolatedUV ? [interpolatedUV] : undefined,
            uvs2: interpolatedUV2 ? [interpolatedUV2] : undefined,
            tangents: interpolatedTangent ? [interpolatedTangent] : undefined,
        };
    }

    /**
     * Generate multiple fiber root positions, normals, etc.
     * @param count Number of fibers to generate
     * @param seedBase Base seed for reproducibility
     * @returns Array of fiber root position data
     */
    generateSurfaceSamples(count: number, seedBase: number = 0): ISurfaceSamplingData {
        const allPositions: Vector3[] = [];
        const allNormals: Vector3[] = [];
        const allSeeds: number[] = [];
        const allTangents: Vector4[] = [];
        const allUVs: Vector2[] = [];
        const allUVs2: Vector2[] = [];
        const allTriangleIndices: number[] = [];
        const allBarycentricCoords: Vector3[] = [];
        const rng = new SimpleRng(seedBase);

        for (let i = 0; i < count; i++) {
            const sample = this.generateSurfaceSample(seedBase + i, rng);
            allPositions.push(...sample.positions);
            allNormals.push(...sample.normals);
            allSeeds.push(...sample.seeds);
            allTangents.push(...(sample.tangents ?? []));
            allUVs.push(...(sample.uvs ?? []));
            allUVs2.push(...(sample.uvs2 ?? []));
            allTriangleIndices.push(...sample.triangleIndices);
            allBarycentricCoords.push(...sample.barycentricCoords);
        }

        return {
            positions: allPositions,
            normals: allNormals,
            seeds: allSeeds,
            tangents: allTangents.length > 0 ? allTangents : undefined,
            uvs: allUVs.length > 0 ? allUVs : undefined,
            uvs2: allUVs2.length > 0 ? allUVs2 : undefined,
            triangleIndices: allTriangleIndices,
            barycentricCoords: allBarycentricCoords,
        };
    }

    /**
     * Uniform triangle sampling using Heitz's low-distortion method
     * @param u Random value [0, 1)
     * @param v Random value [0, 1)
     * @returns Barycentric coordinates
     */
    private _sampleUnitTriangle(u: number, v: number): Vector3 {
        let x: number, y: number;
        if (u > 1.0 || v > 1.0 || u < 0.0 || v < 0.0) {
            throw new Error(`Random values must be in [0, 1), got u=${u}, v=${v}`);
        }
        if (v > u) {
            x = 0.5 * u;
            y = v - x;
        } else {
            y = 0.5 * v;
            x = u - y;
        }

        const z = 1.0 - x - y;
        return new Vector3(x, y, z);
    }

    /**
     * Get total surface area of the mesh
     * @returns Total area
     */
    getTotalArea(): number {
        const scaling = this._mesh.absoluteScaling;
        // Surface area scales by the product of the two scaling components for 2D surface embedded in 3D
        // For non-uniform scaling: area_scaled = area_original * scale_x * scale_y * scale_z^(2/3) in general
        // But for a surface (2D manifold), we need the product of two tangent scale factors
        // Simplest approach: use the determinant's 2/3 power, or just scale_x * scale_y for planar cases
        // For general case with uniform-ish scaling: area scales by average of two dimensions squared
        const scaleX = Math.abs(scaling.x);
        const scaleY = Math.abs(scaling.y);
        const scaleZ = Math.abs(scaling.z);
        // Geometric mean of two largest scales (approximation for surface area scaling)
        const scales = [scaleX, scaleY, scaleZ].sort((a, b) => b - a);
        const areaScale = scales[0] * scales[1];
        return this._totalArea * areaScale;
    }

    /**
     * Get the PMF for direct access if needed
     * @returns PMF instance
     */
    getPmf(): Pmf1d | null {
        return this._pmf;
    }
}

/**
 * Example usage demonstrating fiber root sampling
 * @param scene The Babylon.js scene
 */
export function ExampleFiberSampling(scene: Scene): void {
    // Create or get a mesh
    const sphere = MeshBuilder.CreateIcoSphere("sphere", { radius: 1 }, scene);

    // Create sampler
    const sampler = new MeshSurfaceSampler(sphere);

    // Preprocess mesh (compute PMF)
    console.time("Mesh preprocessing");
    sampler.preprocessMesh();
    console.timeEnd("Mesh preprocessing");

    Logger.Log(`Mesh total area: ${sampler.getTotalArea().toFixed(2)}`);

    // Generate fiber root positions
    console.time("Fiber sampling");
    const fiberCount = 1000;
    const samples = sampler.generateSurfaceSamples(fiberCount, 42);
    console.timeEnd("Fiber sampling");

    Logger.Log(`Generated ${samples.positions.length} fiber root positions`);

    // Visualize root positions with spheres (optional)
    for (let i = 0; i < Math.min(10, samples.positions.length); i++) {
        const debugSphere = MeshBuilder.CreateSphere(`fiber_root_${i}`, { diameter: 0.02, segments: 16 }, scene);
        debugSphere.position = samples.positions[i];
        // debugSphere.material = new StandardMaterial(`mat_${i}`, scene);
        // (debugSphere.material as StandardMaterial).emissiveColor = Color3.Green();
    }
}
