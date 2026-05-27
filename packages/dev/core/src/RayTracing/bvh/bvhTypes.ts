/**
 * GPU buffer layout constants and typed-array helpers for the BVH ray tracer.
 *
 * All sizes are in bytes unless otherwise noted.
 *
 * BVHNode (32 bytes, std430):
 *   float  aabbMinX, aabbMinY, aabbMinZ   (12 bytes)
 *   uint   leftOrFirst                     ( 4 bytes)   leaf → first triangle index; inner → left child index
 *   float  aabbMaxX, aabbMaxY, aabbMaxZ   (12 bytes)
 *   uint   triCountOrMiss                  ( 4 bytes)   leaf → triangle count (\>0); inner → 0
 *
 * TLASInstance (80 bytes, std430):
 *   float  worldToLocal[12]  (mat4x3, column-major, 48 bytes)
 *   uint   blasOffset        ( 4 bytes)  index of first BVH node for this BLAS
 *   uint   geomOffset        ( 4 bytes)  index of first triangle in the triangle buffer
 *   uint   materialIndex     ( 4 bytes)
 *   uint   flags             ( 4 bytes)
 *   float  _pad[4]           (16 bytes)  padding to align to 16-byte boundary
 *
 * Triangle (48 bytes, std430):
 *   float  v0x, v0y, v0z, _pad0   (16 bytes)
 *   float  v1x, v1y, v1z, _pad1   (16 bytes)
 *   float  v2x, v2y, v2z, _pad2   (16 bytes)
 *
 * TriangleAttrib (80 bytes, std430):
 *   float  n0x, n0y, n0z, _pad0   (16 bytes)
 *   float  n1x, n1y, n1z, _pad1   (16 bytes)
 *   float  n2x, n2y, n2z, _pad2   (16 bytes)
 *   float  uv0x, uv0y, uv1x, uv1y (16 bytes)  — UVs for vertices 0 and 1
 *   float  uv2x, uv2y, _pad, _pad  (16 bytes)  — UV for vertex 2 + 8 bytes padding
 */

// ---- BVHNode ----------------------------------------------------------------

/** Size of one BVH node in bytes */
export const BvhNodeStride = 32;
/** Number of floats + uints in a BVHNode */
export const BvhNodeFloats = 8; // 8 × 4 bytes = 32

// ---- TLASInstance -----------------------------------------------------------

/** Size of one TLAS instance in bytes */
export const TlasInstanceStride = 80;

// ---- Triangle ---------------------------------------------------------------

/** Size of one triangle (positions only) in bytes */
export const TriangleStride = 48;

// ---- TriangleAttrib ---------------------------------------------------------

/** Size of one triangle attribute record in bytes */
export const TriangleAttribStride = 80;

// ---- RTMaterial -------------------------------------------------------------

/** Size of one RTMaterial struct in bytes (176 = 11 × 16-byte vec4 slots) */
export const RtMaterialStride = 176;

// ---- Typed-array factory helpers --------------------------------------------

/**
 * Creates a `Float32Array` and `Uint32Array` sharing the same `ArrayBuffer`.
 * Useful for writing mixed float/uint BVH node data.
 * @param nodeCount Number of BVH nodes to allocate
 * @returns Object with both views and the underlying buffer
 */
export function CreateBvhBuffer(nodeCount: number): { f32: Float32Array; u32: Uint32Array; buffer: ArrayBuffer } {
    const buffer = new ArrayBuffer(nodeCount * BvhNodeStride);
    return { f32: new Float32Array(buffer), u32: new Uint32Array(buffer), buffer };
}

/**
 * Creates a flat triangle position buffer.
 * @param triangleCount Number of triangles
 * @returns Float32Array with room for `triangleCount` triangles
 */
export function CreateTriangleBuffer(triangleCount: number): Float32Array {
    return new Float32Array(triangleCount * (TriangleStride / 4));
}

/**
 * Creates a flat triangle attribute buffer (normals + UVs).
 * @param triangleCount Number of triangles
 * @returns Float32Array with room for `triangleCount` triangle attributes
 */
export function CreateTriangleAttribBuffer(triangleCount: number): Float32Array {
    return new Float32Array(triangleCount * (TriangleAttribStride / 4));
}

/**
 * Creates a TLAS instance buffer.
 * @param instanceCount Number of instances
 * @returns Object with both float and uint views sharing the same ArrayBuffer
 */
export function CreateTlasBuffer(instanceCount: number): { f32: Float32Array; u32: Uint32Array; buffer: ArrayBuffer } {
    const buffer = new ArrayBuffer(instanceCount * TlasInstanceStride);
    return { f32: new Float32Array(buffer), u32: new Uint32Array(buffer), buffer };
}
