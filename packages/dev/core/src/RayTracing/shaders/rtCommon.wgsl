// ============================================================================
// rtCommon.wgsl  —  Shared structs and constants for the ray tracer megakernel
// ============================================================================

// ---------- Ray --------------------------------------------------------------

struct Ray {
    origin    : vec3f,
    tMin      : f32,
    direction : vec3f,
    tMax      : f32,
};

// ---------- Hit record -------------------------------------------------------

struct HitRecord {
    /// World-space hit point
    position     : vec3f,
    /// Distance along the ray
    t            : f32,
    /// Interpolated world-space normal (facing outward)
    normal       : vec3f,
    /// 1.0 if we hit the front face, -1.0 if back
    frontFace    : f32,
    /// UV coordinate at the hit point
    uv           : vec2f,
    /// Material index in the RTMaterial buffer
    materialIndex : u32,
    /// Triangle index in the geometry buffer (for debugging)
    triIndex     : u32,
};

fn makeHitRecord() -> HitRecord {
    var h : HitRecord;
    h.t = 1e30;
    h.materialIndex = 0u;
    h.triIndex = 0u;
    return h;
}

// ---------- BVH node (matches bvhTypes.ts layout) ----------------------------

struct BVHNode {
    aabbMin     : vec3f,
    leftOrFirst : u32,       // inner → left child index; leaf → first tri index
    aabbMax     : vec3f,
    triCount    : u32,       // 0 = inner node; >0 = leaf
};

// ---------- TLAS instance (matches bvhTypes.ts layout) -----------------------

struct TLASInstance {
    // mat4x3 stored as 4 × vec4f (column-major, only xyz used per column)
    col0        : vec4f,
    col1        : vec4f,
    col2        : vec4f,
    col3        : vec4f,   // translation
    blasOffset  : u32,
    geomOffset  : u32,
    materialIndex : u32,
    flags       : u32,
    _pad        : vec4f,
};

// Reconstruct the 4×4 world-to-local matrix from a TLASInstance
fn tlasWorldToLocal(inst : TLASInstance) -> mat4x4f {
    return mat4x4f(
        vec4f(inst.col0.xyz, 0.0),
        vec4f(inst.col1.xyz, 0.0),
        vec4f(inst.col2.xyz, 0.0),
        vec4f(inst.col3.xyz, 1.0),
    );
}

// ---------- RTMaterial (matches rtMaterialManager.ts layout) -----------------

struct RTMaterial {
    baseColor          : vec3f,
    baseMetalness      : f32,
    emissionColor      : vec3f,
    emissionLuminance  : f32,
    specularRoughness  : f32,
    specularIor        : f32,
    transmissionWeight : f32,
    geometryOpacity    : f32,
    coatWeight         : f32,
    coatRoughness      : f32,
    coatIor            : f32,
    subsurfaceWeight   : f32,
    subsurfaceColor    : vec3f,
    subsurfaceRadius   : f32,
    fuzzWeight         : f32,
    fuzzRoughness      : f32,
    _pad0              : vec2f,
    _reserved          : array<vec4f, 2>,
};

// ---------- Uniform frame constants ------------------------------------------

struct FrameUniforms {
    invViewProj     : mat4x4f,
    cameraPosition  : vec3f,
    sampleIndex     : u32,      // current accumulated sample count
    outputSize      : vec2f,
    jitter          : vec2f,    // sub-pixel jitter for progressive accumulation
    maxBounces      : u32,
    instanceCount   : u32,
    _pad            : vec2u,
};

// ---------- PCG random number generator --------------------------------------

fn pcgHash(seed : u32) -> u32 {
    let state = seed * 747796405u + 2891336453u;
    let word  = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

fn randomFloat(seed : ptr<function, u32>) -> f32 {
    *seed = pcgHash(*seed);
    return f32(*seed) / 4294967296.0;
}

fn randomVec2(seed : ptr<function, u32>) -> vec2f {
    return vec2f(randomFloat(seed), randomFloat(seed));
}

fn randomInUnitSphere(seed : ptr<function, u32>) -> vec3f {
    loop {
        let v = vec3f(randomFloat(seed), randomFloat(seed), randomFloat(seed)) * 2.0 - vec3f(1.0);
        if dot(v, v) < 1.0 { return normalize(v); }
    }
}

// ---------- AABB slab test ---------------------------------------------------

fn intersectAABB(ray : Ray, minB : vec3f, maxB : vec3f) -> f32 {
    let invD = 1.0 / ray.direction;
    let t0   = (minB - ray.origin) * invD;
    let t1   = (maxB - ray.origin) * invD;
    let tNear = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
    let tFar  = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
    if tFar < 0.0 || tNear > tFar { return -1.0; }
    return tNear;
}

// ---------- Möller-Trumbore triangle intersection ----------------------------

fn intersectTriangle(ray : Ray, v0 : vec3f, v1 : vec3f, v2 : vec3f) -> vec4f {
    // Returns vec4f(t, u, v, 1.0) on hit, or vec4f(0,0,0,-1) on miss
    let e1 = v1 - v0;
    let e2 = v2 - v0;
    let h  = cross(ray.direction, e2);
    let a  = dot(e1, h);
    if abs(a) < 1e-8 { return vec4f(0.0, 0.0, 0.0, -1.0); }
    let f  = 1.0 / a;
    let s  = ray.origin - v0;
    let u  = f * dot(s, h);
    if u < 0.0 || u > 1.0 { return vec4f(0.0, 0.0, 0.0, -1.0); }
    let q  = cross(s, e1);
    let v  = f * dot(ray.direction, q);
    if v < 0.0 || (u + v) > 1.0 { return vec4f(0.0, 0.0, 0.0, -1.0); }
    let t  = f * dot(e2, q);
    if t < ray.tMin || t > ray.tMax { return vec4f(0.0, 0.0, 0.0, -1.0); }
    return vec4f(t, u, v, 1.0);
}
