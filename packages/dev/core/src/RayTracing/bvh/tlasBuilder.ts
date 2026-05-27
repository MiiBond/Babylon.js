import { TlasInstanceStride } from "./bvhTypes";

/**
 * A single entry describing one mesh instance to include in the TLAS.
 */
export interface ITlasInstanceDesc {
    /**
     * World-to-local transform (inverse of the mesh's world matrix) as a
     * column-major 4×4 Float32Array (16 elements).  The builder writes
     * only the first 3 columns (12 elements) to keep the struct at 80 bytes.
     */
    worldToLocal: Float32Array;
    /** Byte offset of the first BVH node for this mesh's BLAS in the combined node buffer */
    blasByteOffset: number;
    /** Index of the first triangle for this mesh in the combined triangle buffer */
    geomOffset: number;
    /** Index into the RTMaterial buffer */
    materialIndex: number;
    /** Reserved flags (set to 0 for now) */
    flags?: number;
}

/**
 * Packs an array of instance descriptors into a GPU-ready TLAS buffer.
 * @param instances Array of instance descriptors
 * @returns An ArrayBuffer in the TLASInstance layout (80 bytes / instance)
 */
export function BuildTlas(instances: ITlasInstanceDesc[]): ArrayBuffer {
    const count = instances.length;
    const buffer = new ArrayBuffer(count * TlasInstanceStride);
    const f32 = new Float32Array(buffer);
    const u32 = new Uint32Array(buffer);
    const stride = TlasInstanceStride / 4; // floats per instance = 20

    for (let i = 0; i < count; i++) {
        const inst = instances[i];
        const base = i * stride;
        const wtl = inst.worldToLocal;

        // Column 0 (rows 0-2)
        f32[base + 0] = wtl[0];
        f32[base + 1] = wtl[1];
        f32[base + 2] = wtl[2];
        // Column 1 (rows 0-2)
        f32[base + 3] = wtl[4];
        f32[base + 4] = wtl[5];
        f32[base + 5] = wtl[6];
        // Column 2 (rows 0-2)
        f32[base + 6] = wtl[8];
        f32[base + 7] = wtl[9];
        f32[base + 8] = wtl[10];
        // Column 3 (rows 0-2 = translation part)
        f32[base + 9] = wtl[12];
        f32[base + 10] = wtl[13];
        f32[base + 11] = wtl[14];

        // blasOffset = byte offset → convert to node index
        u32[base + 12] = (inst.blasByteOffset / 32) | 0;
        u32[base + 13] = inst.geomOffset;
        u32[base + 14] = inst.materialIndex;
        u32[base + 15] = inst.flags ?? 0;
        // bytes 64-79 are padding (indices 16-19) — left as zero
    }

    return buffer;
}
