// ============================================================================
// rtUserHooks.wgsl  —  Default no-op implementations of user-injectable hooks
//
// The megakernel includes this file and then optionally replaces these
// functions via ComputeShader.processFinalCode string substitution.
//
// Users can override any of these three entry points:
//
//   RT_USER_RAY_GEN    — modify the primary ray before traversal
//   RT_USER_CLOSEST_HIT — shade a hit (overrides the built-in OpenPBR shading)
//   RT_USER_MISS       — shade a miss (overrides the built-in sky shading)
//
// Signatures must be kept exactly as below.
// ============================================================================

// Called after the primary ray is constructed from the camera but before
// traversal begins.  Modify `ray` in-place to implement lens effects, etc.
// Default: no-op.
fn userRayGen(ray : ptr<function, Ray>, seed : ptr<function, u32>) {
    // Default: no modification
}

// Called when a ray hits a surface.  Return the outgoing radiance contribution
// for this bounce.  `depth` is the bounce index (0 = primary ray).
// Default: not invoked — the built-in OpenPBR shading is used instead.
// To override, replace this function via processFinalCode.
fn userClosestHit(hit : HitRecord, ray : Ray, mat : RTMaterial, depth : u32, seed : ptr<function, u32>) -> vec4f {
    // Returning vec4f(-1.0) signals "use default shading"
    return vec4f(-1.0);
}

// Called when a ray misses all geometry.  Return the sky/environment radiance.
// Default: not invoked — the built-in sky shading is used instead.
// To override, replace this function via processFinalCode.
fn userMiss(ray : Ray, depth : u32, seed : ptr<function, u32>) -> vec4f {
    // Returning vec4f(-1.0) signals "use default shading"
    return vec4f(-1.0);
}
