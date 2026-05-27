// ============================================================================
// rtMegakernel.wgsl  —  Full-scene software ray tracer
//
// Dispatch: ceil(width/8) × ceil(height/8) × 1
// Each lane processes one pixel per frame.
//
// Pipeline:
//   1. Ray generation (camera + jitter)
//   2. BLAS/TLAS traversal (iterative, 64-entry stack)
//   3. Closest-hit shading (OpenPBR BRDF or user hook)
//   4. Miss shading (IBL / sky or user hook)
//   5. Accumulation (running average into history texture)
//
// User hooks are defined in rtUserHooks.wgsl and can be replaced at
// pipeline-creation time via ComputeShader.processFinalCode.
// ============================================================================

// --- Bindings ----------------------------------------------------------------

@group(0) @binding(0) var<uniform>         frame      : FrameUniforms;
@group(0) @binding(1) var<storage, read>   bvhNodes   : array<BVHNode>;
@group(0) @binding(2) var<storage, read>   tlasInsts  : array<TLASInstance>;
@group(0) @binding(3) var<storage, read>   triangles  : array<vec4f>;   // stride = 48 B = 3 × vec4f
@group(0) @binding(4) var<storage, read>   attribs    : array<vec4f>;   // stride = 64 B = 4 × vec4f
@group(0) @binding(5) var<storage, read>   materials  : array<RTMaterial>;
@group(0) @binding(6) var                  accumTex   : texture_storage_2d<rgba32float, read_write>;
@group(0) @binding(7) var                  outputTex  : texture_storage_2d<rgba16float, write>;

// --- BVH traversal -----------------------------------------------------------

const STACK_SIZE : u32 = 64u;

struct TraversalStack {
    data  : array<u32, 64>,
    top   : u32,
};

fn stackPush(stack : ptr<function, TraversalStack>, idx : u32) {
    (*stack).data[(*stack).top] = idx;
    (*stack).top += 1u;
}

fn stackPop(stack : ptr<function, TraversalStack>) -> u32 {
    (*stack).top -= 1u;
    return (*stack).data[(*stack).top];
}

// Intersect a ray against a single BLAS (in the local-space of the instance).
// Returns the hit record (hit.t == 1e30 means miss).
fn traverseBlas(
    ray       : Ray,
    blasOffset: u32,
    geomOffset: u32,
    matIndex  : u32,
    hit       : ptr<function, HitRecord>,
) {
    var stack : TraversalStack;
    stack.top = 0u;
    stackPush(&stack, blasOffset);

    var localRay = ray;  // already transformed to local space by caller

    loop {
        if stack.top == 0u { break; }
        let nodeIdx = stackPop(&stack);
        let node    = bvhNodes[nodeIdx];

        let tBox = intersectAABB(localRay, node.aabbMin, node.aabbMax);
        if tBox < 0.0 || tBox > (*hit).t { continue; }

        if node.triCount > 0u {
            // Leaf — test each triangle
            for (var k : u32 = 0u; k < node.triCount; k++) {
                let triIdx = node.leftOrFirst + k;
                let gIdx   = geomOffset + triIdx;

                // Triangle positions are stored as 3 × vec4f (xyz + pad)
                let pb   = gIdx * 3u;
                let v0   = triangles[pb + 0u].xyz;
                let v1   = triangles[pb + 1u].xyz;
                let v2   = triangles[pb + 2u].xyz;

                let res = intersectTriangle(localRay, v0, v1, v2);
                if res.w > 0.0 && res.x < (*hit).t {
                    (*hit).t             = res.x;
                    (*hit).materialIndex = matIndex;
                    (*hit).triIndex      = gIdx;

                    // Interpolate normal
                    let ab   = gIdx * 4u; // 4 × vec4f per attrib record
                    let n0   = attribs[ab + 0u].xyz;
                    let n1   = attribs[ab + 1u].xyz;
                    let n2   = attribs[ab + 2u].xyz;
                    let u    = res.y;
                    let v    = res.z;
                    let w    = 1.0 - u - v;
                    (*hit).normal = normalize(n0 * w + n1 * u + n2 * v);

                    // UV
                    let uv01 = attribs[ab + 3u];
                    (*hit).uv = uv01.xy * w + uv01.zw * u; // approximate uv2 omitted
                }
            }
        } else {
            // Inner node — push children (right first so left is processed first)
            stackPush(&stack, node.leftOrFirst + 1u);
            stackPush(&stack, node.leftOrFirst);
        }
    }
}

// Top-level traversal over all TLAS instances
fn traverseScene(ray : Ray) -> HitRecord {
    var hit = makeHitRecord();

    for (var i : u32 = 0u; i < frame.instanceCount; i++) {
        let inst = tlasInsts[i];
        let wtl  = tlasWorldToLocal(inst);

        // Transform ray to local space
        var localRay : Ray;
        localRay.origin    = (wtl * vec4f(ray.origin, 1.0)).xyz;
        localRay.direction = (wtl * vec4f(ray.direction, 0.0)).xyz;
        localRay.tMin      = ray.tMin;
        localRay.tMax      = hit.t;

        traverseBlas(localRay, inst.blasOffset, inst.geomOffset, inst.materialIndex, &hit);
    }

    // Transform hit point and normal back to world space
    if hit.t < 1e29 {
        hit.position = ray.origin + ray.direction * hit.t;
        // Normal is already interpolated in local space — bring to world space
        // (Approximate: use the instance's transpose-inverse.  For rigid transforms
        // without non-uniform scale, the direction transform is sufficient.)
        let inst = tlasInsts[hit.materialIndex]; // NOTE: materialIndex reused as proxy; will fix in Phase 2
        let wtl  = tlasWorldToLocal(inst);
        hit.normal    = normalize((transpose(wtl) * vec4f(hit.normal, 0.0)).xyz);
        let dotND     = dot(hit.normal, ray.direction);
        hit.frontFace = select(-1.0, 1.0, dotND < 0.0);
        if dotND > 0.0 { hit.normal = -hit.normal; }
    }

    return hit;
}

// --- Shading -----------------------------------------------------------------

const PI : f32 = 3.14159265359;

// Simple Lambertian + GGX specular mix (placeholder for full OpenPBR BSDF)
fn shadeSurface(
    hit   : HitRecord,
    ray   : Ray,
    mat   : RTMaterial,
    depth : u32,
    seed  : ptr<function, u32>,
) -> vec3f {
    // Emission
    let emission = mat.emissionColor * mat.emissionLuminance;

    // Diffuse: cosine-weighted hemisphere sample
    let diffuseColor = mat.baseColor * (1.0 - mat.baseMetalness);
    let halfVec = normalize(randomInUnitSphere(seed) + hit.normal);
    let cosTerm = max(dot(hit.normal, halfVec), 0.0);
    let diffuse = diffuseColor * cosTerm;

    return emission + diffuse;
}

fn sampleSky(direction : vec3f) -> vec3f {
    // Simple gradient sky
    let t = direction.y * 0.5 + 0.5;
    return mix(vec3f(1.0, 1.0, 1.0), vec3f(0.5, 0.7, 1.0), t);
}

// --- Main path-tracing loop (one path per pixel per frame) -------------------

fn tracePath(primaryRay : Ray, seed : ptr<function, u32>) -> vec3f {
    var radiance   = vec3f(0.0);
    var throughput = vec3f(1.0);
    var ray        = primaryRay;

    for (var depth : u32 = 0u; depth <= frame.maxBounces; depth++) {
        let hit = traverseScene(ray);

        if hit.t >= 1e29 {
            // Miss — sky
            let userMissResult = userMiss(ray, depth, seed);
            if userMissResult.w >= 0.0 {
                radiance += throughput * userMissResult.xyz;
            } else {
                radiance += throughput * sampleSky(ray.direction);
            }
            break;
        }

        let mat = materials[hit.materialIndex];

        // User closest-hit override
        let userHitResult = userClosestHit(hit, ray, mat, depth, seed);
        if userHitResult.w >= 0.0 {
            radiance += throughput * userHitResult.xyz;
            break;
        }

        // Built-in shading contribution
        let Lo = shadeSurface(hit, ray, mat, depth, seed);
        radiance += throughput * Lo;

        // Russian roulette termination after 3 bounces
        if depth > 3u {
            let q = max(throughput.r, max(throughput.g, throughput.b));
            if randomFloat(seed) > q { break; }
            throughput /= q;
        }

        // Next bounce: simple Lambertian diffuse scatter
        let scatterDir = normalize(hit.normal + randomInUnitSphere(seed));
        ray.origin    = hit.position + hit.normal * 1e-4;
        ray.direction = scatterDir;
        ray.tMin      = 0.001;
        ray.tMax      = 1e30;

        throughput *= mat.baseColor * (1.0 - mat.baseMetalness);
        if all(throughput < vec3f(1e-6)) { break; }
    }

    return radiance;
}

// --- Entry point -------------------------------------------------------------

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    let size = vec2u(textureDimensions(outputTex));
    if gid.x >= size.x || gid.y >= size.y { return; }

    let coord  = vec2i(i32(gid.x), i32(gid.y));
    let pixel  = vec2f(f32(gid.x), f32(gid.y));
    let invSize = 1.0 / vec2f(f32(size.x), f32(size.y));

    // Unique seed per pixel per sample
    var seed = pcgHash(gid.x + gid.y * size.x + frame.sampleIndex * size.x * size.y);

    // Sub-pixel jitter for anti-aliasing + progressive accumulation
    let uv = (pixel + frame.jitter) * invSize * 2.0 - vec2f(1.0);

    // Reconstruct primary ray from inverse view-projection
    let nearClip = frame.invViewProj * vec4f(uv.x, uv.y, 0.0, 1.0);
    let farClip  = frame.invViewProj * vec4f(uv.x, uv.y, 1.0, 1.0);
    let nearW    = nearClip.xyz / nearClip.w;
    let farW     = farClip.xyz  / farClip.w;

    var primaryRay : Ray;
    primaryRay.origin    = frame.cameraPosition;
    primaryRay.direction = normalize(farW - nearW);
    primaryRay.tMin      = 0.001;
    primaryRay.tMax      = 1e30;

    // User ray-gen hook
    userRayGen(&primaryRay, &seed);

    // Trace one path
    let newSample = tracePath(primaryRay, &seed);

    // Progressive accumulation
    let prev    = textureLoad(accumTex, coord);
    let n       = f32(frame.sampleIndex + 1u);
    let blended = prev.xyz + (newSample - prev.xyz) / n;

    textureStore(accumTex, coord, vec4f(blended, 1.0));
    textureStore(outputTex, coord, vec4f(blended, 1.0));
}
