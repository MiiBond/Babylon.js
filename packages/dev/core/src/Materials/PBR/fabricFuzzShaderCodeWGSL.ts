/**
 * WGSL shader code constants for FabricFuzz plugin material
 * This file contains all the shader code snippets that are injected into shaders
 * when rendering fabric fuzz fibers.
 */
export const FabricFuzzVertexSamplers = `
#ifdef FABRIC_FUZZ
    var ffPositionSeedTexture: texture_2d<f32>;
    var ffPositionSeedTextureSampler: sampler;
    var ffNormalTexture: texture_2d<f32>;
    var ffNormalTextureSampler: sampler;
    var ffUVTexture: texture_2d<f32>;
    var ffUVTextureSampler: sampler;
    #ifdef FABRIC_FUZZ_TANGENTS
        var ffTangentTexture: texture_2d<f32>;
        var ffTangentTextureSampler: sampler;
    #endif
    
    // Fiber parameter textures
    #ifdef FABRIC_FUZZ_DENSITY_TEXTURE
        var fiberDensityTexture: texture_2d<f32>;
        var fiberDensityTextureSampler: sampler;
    #endif
    #ifdef FABRIC_FUZZ_LENGTH_TEXTURE
        var fiberLengthTexture: texture_2d<f32>;
        var fiberLengthTextureSampler: sampler;
    #endif
    #ifdef FABRIC_FUZZ_RADIUS_TEXTURE
        var fiberRadiusTexture: texture_2d<f32>;
        var fiberRadiusTextureSampler: sampler;
    #endif
    #ifdef FABRIC_FUZZ_TILT_TEXTURE
        var fiberTiltTexture: texture_2d<f32>;
        var fiberTiltTextureSampler: sampler;
    #endif
    #ifdef FABRIC_FUZZ_CHAOS_TEXTURE
        var fiberChaosTexture: texture_2d<f32>;
        var fiberChaosTextureSampler: sampler;
    #endif
    #ifdef FABRIC_FUZZ_CURL_TEXTURE
        var fiberCurlTexture: texture_2d<f32>;
        var fiberCurlTextureSampler: sampler;
    #endif
    #ifdef FABRIC_FUZZ_TAPER_TEXTURE
        var fiberTaperTexture: texture_2d<f32>;
        var fiberTaperTextureSampler: sampler;
    #endif
#endif
`;

export const FabricFuzzVertexUniforms = `
#ifdef FABRIC_FUZZ
    // Fiber parameters
    uniform surfaceMeshToWorld: mat4x4f;
    uniform fiberSegments: f32;
    uniform fiberLength: f32;
    uniform fiberLengthVariation: f32;
    uniform fiberRadius: f32;
    uniform fiberRotation: f32;
    uniform fiberRotationVariation: f32;
    uniform fiberTilt: f32;
    uniform fiberCurl: f32;
    uniform fiberChaos: f32;
    uniform fiberTaper: f32;
    uniform fiberTaperStart: f32;
    uniform fiberOffset: f32; // Offset into the instance data textures
#endif
`;

export const FabricFuzzVertexDeclarations = `
#ifdef FABRIC_FUZZ
    // Varyings for passing data to the fragment shader
    varying vFiberBasisX: vec3f;
    varying vFiberBasisZ: vec3f;
    varying vFiberUV: vec2f;
    varying vTipColorBlend: f32;

    // Read the position or normal for the current instance (instanceIndex)
    fn readFiberInstanceData(dataTexture: texture_2d<f32>, instanceIndex: u32) -> vec4f {
        // Get the ID of the current instance
        let instanceId = f32(instanceIndex) + uniforms.fiberOffset;
        let texSize = textureDimensions(dataTexture, 0);
        let size = f32(texSize.x);
        
        // Calculate UV coordinate (we are sampling from a 2D texture)
        let u: i32 = i32(instanceId) % i32(size);
        let v: i32 = i32(floor(instanceId / size));

        // Sample the texture.
        return textureLoad(dataTexture, vec2i(u, v), 0); // Add 0.5/size for pixel center
    }

    #ifndef FABRIC_FUZZ_USE_TANGENT
        /**
         * Robustly creates an orthonormal basis matrix for the fiber instance
         * where the Y-axis (fiber length) is aligned with the surface normal.
         */
        fn createOrthoMatrix(surfaceNormal: vec3f) -> mat3x3f {
            // The new Y-axis (fiber length) is the surface Normal
            let newY = surfaceNormal;

            // 1. Calculate a robust X-axis (Tangent)
            // Pick a temporary vector that is NOT parallel to the normal (usually X or Z)
            var tempVector = vec3f(1.0, 0.0, 0.0);
            if (abs(newY.x) > 0.9) {
                tempVector = vec3f(0.0, 1.0, 0.0);
            }
            
            // Use Gram-Schmidt process to find X-axis perpendicular to Y
            let newX = normalize(cross(newY, tempVector));

            // 2. Calculate the Z-axis (Binormal), which is perpendicular to X and Y
            let newZ = cross(newX, newY);
            
            // 3. Combine Translation, Rotation (Basis), and Scale into the final matrix
            var finalMatrix: mat3x3f;
            finalMatrix[0] = newX;
            finalMatrix[1] = newY; 
            finalMatrix[2] = newZ;

            return finalMatrix;
        }
    #endif
    
    // Random Number Generation
    var<private> rngState: u32;

    fn initRNG(seed: f32) {
        // Manual float-to-uint conversion for maximum compatibility
        let i = i32(seed * 10000.0);
        var uintSeed = u32(abs(i));
        
        // Mix the bits to improve seed quality
        uintSeed = (uintSeed ^ 61u) ^ (uintSeed >> 16u);
        uintSeed *= 9u;
        uintSeed = uintSeed ^ (uintSeed >> 4u);
        uintSeed *= 0x27d4eb2du;
        uintSeed = uintSeed ^ (uintSeed >> 15u);
        
        rngState = uintSeed;
    }

    fn randUint() -> u32 {
        // Linear Congruential Generator (same constants as glibc)
        const LCG_A = 1664525u;
        const LCG_C = 1013904223u;
        rngState = (LCG_A * rngState + LCG_C);
        return rngState;
    }

    fn randFloat() -> f32 {
        const RCP_UINT_MAX = 2.3283064365386963e-10; // 1.0 / (2^32)
        return f32(randUint()) * RCP_UINT_MAX;
    }
#endif
`;

export const FabricFuzzVertexMainBegin = `
#ifdef FABRIC_FUZZ
    // Read data for the current instance
    let positionSeedData = readFiberInstanceData(ffPositionSeedTexture, input.instanceIndex);
    let ffSurfaceNormal = readFiberInstanceData(ffNormalTexture, input.instanceIndex).xyz;
    let ffSurfaceUVData = readFiberInstanceData(ffUVTexture, input.instanceIndex);
    #ifdef FABRIC_FUZZ_TANGENTS
        let tangentData = readFiberInstanceData(ffTangentTexture, input.instanceIndex);
    #endif
#endif
`;

export const FabricFuzzVertexUpdateWorldPos = `
#ifdef FABRIC_FUZZ
    let rootPos = positionSeedData.xyz;
    let seed = positionSeedData.w;
    initRNG(seed);

    #ifdef MAINUV1
        let ffSurfaceUV1 = ffSurfaceUVData.xy;
    #endif
    #ifdef MAINUV2
        let ffSurfaceUV2 = ffSurfaceUVData.zw;
    #endif
    
    // Sample parameter textures to modulate fiber properties
    var texDensity = 1.0;
    var texLength = 1.0;
    var texRadius = 1.0;
    var texTilt = 1.0;
    var texChaos = 1.0;
    var texCurl = 1.0;
    var texTaper = 1.0;
    var texTipColorBlend = 1.0;
    
    #ifdef FABRIC_FUZZ_DENSITY_TEXTURE
        #ifdef MAINUV1
            texDensity = textureSampleLevel(fiberDensityTexture, fiberDensityTextureSampler, ffSurfaceUV1, 0.0).r;
        #endif
    #endif
    #ifdef FABRIC_FUZZ_LENGTH_TEXTURE
        #ifdef MAINUV1
            texLength = textureSampleLevel(fiberLengthTexture, fiberLengthTextureSampler, ffSurfaceUV1, 0.0).r;
        #endif
    #endif
    #ifdef FABRIC_FUZZ_RADIUS_TEXTURE
        #ifdef MAINUV1
            texRadius = textureSampleLevel(fiberRadiusTexture, fiberRadiusTextureSampler, ffSurfaceUV1, 0.0).r;
        #endif
    #endif
    #ifdef FABRIC_FUZZ_TILT_TEXTURE
        #ifdef MAINUV1
            texTilt = textureSampleLevel(fiberTiltTexture, fiberTiltTextureSampler, ffSurfaceUV1, 0.0).r;
        #endif
    #endif
    #ifdef FABRIC_FUZZ_CHAOS_TEXTURE
        #ifdef MAINUV1
            texChaos = textureSampleLevel(fiberChaosTexture, fiberChaosTextureSampler, ffSurfaceUV1, 0.0).r;
        #endif
    #endif
    #ifdef FABRIC_FUZZ_CURL_TEXTURE
        #ifdef MAINUV1
            texCurl = textureSampleLevel(fiberCurlTexture, fiberCurlTextureSampler, ffSurfaceUV1, 0.0).r;
        #endif
    #endif
    #ifdef FABRIC_FUZZ_TAPER_TEXTURE
        #ifdef MAINUV1
            texTaper = textureSampleLevel(fiberTaperTexture, fiberTaperTextureSampler, ffSurfaceUV1, 0.0).r;
        #endif
    #endif
    
    // Apply texture modulation to parameters
    let modifiedLength = uniforms.fiberLength * texLength;
    let modifiedRadius = uniforms.fiberRadius * texRadius;
    let modifiedTilt = uniforms.fiberTilt * texTilt;
    let modifiedChaos = uniforms.fiberChaos * texChaos;
    let modifiedCurl = uniforms.fiberCurl * texCurl;
    let modifiedTaper = uniforms.fiberTaper * texTaper;
    
    #ifdef FABRIC_FUZZ_TANGENTS
        vertexOutputs.vFiberBasisX = tangentData.xyz;
        vertexOutputs.vFiberBasisZ = cross(ffSurfaceNormal, vertexOutputs.vFiberBasisX) * tangentData.w;
    #else
        {
        let instanceMatrix = createOrthoMatrix(ffSurfaceNormal);
        vertexOutputs.vFiberBasisX = instanceMatrix[0]; 
        vertexOutputs.vFiberBasisZ = instanceMatrix[2];
        }
    #endif

    // Compute starting direction (tilt + rotation)
    // Apply rotation variation
    let baseRotationAngle = uniforms.fiberRotation * TWO_PI;
    let rotationOffset = (randFloat() - 0.5) * uniforms.fiberRotationVariation * TWO_PI;
    let finalRotationAngle = baseRotationAngle + rotationOffset;
    
    // Rotate tangent around normal
    let rotatedTangent = vertexOutputs.vFiberBasisX * cos(finalRotationAngle) + 
                        vertexOutputs.vFiberBasisZ * sin(finalRotationAngle);
    let rotatedBitangent = cross(ffSurfaceNormal, rotatedTangent);
    
    // Apply tilt (angle away from normal toward tangent)
    let tiltAngle = modifiedTilt * HALF_PI;
    var fiberDirection = ffSurfaceNormal * cos(tiltAngle) + 
                        rotatedTangent * sin(tiltAngle);
    fiberDirection = normalize((vec4f(fiberDirection, 0.0) * transpose(uniforms.surfaceMeshToWorld)).xyz);

    // Extract triangle strip information
    // For a triangle strip: 
    // - The fiber's is 1 unit high so the progress along fiber is position.y (0=root, 1=tip)
    // - position.x is the signed offset from center (-1 to +1)
    let vertexProgress = positionUpdated.y;
    
    let vertexIndex = u32(vertexProgress * uniforms.fiberSegments);
    
    // Strip width parameter: -1 = left edge, 0 = center, +1 = right edge
    let stripOffset = positionUpdated.x;  // Assumes strip is in XY plane, offset in X
    
    // Calculate deformed spine position at this vertex
    let baseSegmentLength = modifiedLength / uniforms.fiberSegments;
    
    var spinePosition = (uniforms.surfaceMeshToWorld * vec4f(rootPos, 1.0)).xyz;
    var currentDirection = fiberDirection;
    
    var stableRight = rotatedTangent;
    var stableBitangent = rotatedBitangent;
    
    let curlAnglePerSegment = modifiedCurl * PI / max(1.0, uniforms.fiberSegments - 1.0);
    let maxChaosAnglePerSegment = modifiedChaos * HALF_PI;
    
    // Walk through segments up to current vertex
    for (var seg = 0u; seg < vertexIndex; seg++) {
        let prevDirection = currentDirection;
        
        let segmentLengthVariation = (randFloat() - 0.5) * uniforms.fiberLengthVariation * baseSegmentLength * 2.0;
        let segmentLength = baseSegmentLength + segmentLengthVariation;
        
        if (curlAnglePerSegment > 0.0) {
            let curlAxis = normalize(cross(currentDirection, stableBitangent));
            currentDirection = currentDirection * cos(curlAnglePerSegment) - 
                            curlAxis * sin(curlAnglePerSegment);
            currentDirection = normalize(currentDirection);
        }
        
        if (maxChaosAnglePerSegment > 0.0) {
            let cosMaxChaos = cos(maxChaosAnglePerSegment);
            let cosChaos = cosMaxChaos + (1.0 - cosMaxChaos) * randFloat();
            let sinChaos = sqrt(1.0 - cosChaos * cosChaos);
            let azimuth = TWO_PI * randFloat();
            
            var perpendicular1 = normalize(cross(currentDirection, stableBitangent));
            if (length(perpendicular1) < 0.01) {
                perpendicular1 = normalize(cross(currentDirection, vec3f(0.0, 1.0, 0.0)));
                if (length(perpendicular1) < 0.01) {
                    perpendicular1 = normalize(cross(currentDirection, vec3f(1.0, 0.0, 0.0)));
                }
            }
            let perpendicular2 = cross(currentDirection, perpendicular1);
            
            currentDirection = currentDirection * cosChaos + 
                            perpendicular1 * sinChaos * sin(azimuth) +
                            perpendicular2 * sinChaos * cos(azimuth);
            currentDirection = normalize(currentDirection);
        }
        
        // Parallel transport
        let rotationAxis = cross(prevDirection, currentDirection);
        let rotationAxisLength = length(rotationAxis);
        
        if (rotationAxisLength > 0.0001) {
            let rotationAxisNorm = rotationAxis / rotationAxisLength;
            let rotationAngle = asin(min(1.0, rotationAxisLength));
            let cosAngle = cos(rotationAngle);
            let sinAngle = sin(rotationAngle);
            
            let newStableRight = stableRight * cosAngle + 
                                cross(rotationAxisNorm, stableRight) * sinAngle + 
                                rotationAxisNorm * dot(rotationAxisNorm, stableRight) * (1.0 - cosAngle);
            
            let newStableBitangent = stableBitangent * cosAngle + 
                                    cross(rotationAxisNorm, stableBitangent) * sinAngle + 
                                    rotationAxisNorm * dot(rotationAxisNorm, stableBitangent) * (1.0 - cosAngle);
            
            stableRight = normalize(newStableRight);
            stableBitangent = normalize(newStableBitangent);
        }
        
        spinePosition += currentDirection * segmentLength;
    }

    // Apply tapering to radius based on vertex progress
    let taperProgress = max(0.0, vertexProgress - uniforms.fiberTaperStart);
    let taperScale = 1.0 - (taperProgress / max(0.001, 1.0 - uniforms.fiberTaperStart)) * modifiedTaper;
    let currentRadius = modifiedRadius * taperScale;
    
    // Orient strip to face camera (billboard effect)
    let fiberForward = normalize(currentDirection);
    
    // Compute direction from spine to camera
    let toCamera = normalize(scene.vEyePosition.xyz - spinePosition);
    
    // Strip right direction is perpendicular to both fiber forward and to-camera
    let stripRight = normalize(cross(fiberForward, toCamera));
    
    vertexOutputs.vFiberBasisX = stripRight;
    vertexOutputs.vFiberBasisZ = -cross(fiberForward, stripRight);
    vertexOutputs.vFiberUV = vec2f(stripOffset, vertexProgress);

    // Position vertex along strip width     
    let finalPosition = spinePosition + stripRight * stripOffset * currentRadius;
    // Transform local position to world space
    worldPos = vec4f(finalPosition, 1.0);
    positionUpdated = worldPos.xyz;
#endif
`;

export const FabricFuzzVertexUpdateUVs = `
#ifdef FABRIC_FUZZ
    #ifdef MAINUV1
        // Use the surface UV as the base
        uvUpdated = ffSurfaceUV1;
    #endif
    #ifdef MAINUV2
        uv2Updated = ffSurfaceUV2;
    #endif
    #ifdef MAINUV1
        // Use the surface UV as the base
        vertexOutputs.vMainUV1 = ffSurfaceUV1;
    #endif
    #ifdef MAINUV2
        // Use the surface UV as the base
        vertexOutputs.vMainUV2 = ffSurfaceUV2;
    #endif
#endif
`;

export const FabricFuzzFragmentDeclarations = `
#ifdef FABRIC_FUZZ
    #ifdef FABRIC_FUZZ_TIP_COLOR_TEXTURE
        var fiberTipColorTexture: texture_2d<f32>;
        var fiberTipColorTextureSampler: sampler;
    #endif
    varying vFiberBasisX: vec3f;
    varying vFiberBasisZ: vec3f;
    varying vFiberUV: vec2f;
#endif
`;

export const FabricFuzzFragmentMainBegin = `
#ifdef FABRIC_FUZZ

    #ifdef FABRIC_FUZZ_TIP_COLOR_TEXTURE
        #ifdef MAINUV1
            let texTipColor = textureSampleLevel(fiberTipColorTexture, fiberTipColorTextureSampler, fragmentInputs.vMainUV1, 0.0).r;
        #endif
    #endif
    // Compute lighting based on fiber orientation
    let localX = cos(PI * fragmentInputs.vFiberUV.x - HALF_PI);
    let localCylinderNormal = normalize(vec3f(localX, 0.0, 1.0 - abs(localX)));

    // 2. Transform the local normal to world space using the interpolated basis vectors (TBN)
    // Since the local normal only has X and Z components (in local hair space):
    var fiberNormalW = normalize(
        localCylinderNormal.x * fragmentInputs.vFiberBasisX +
        localCylinderNormal.z * fragmentInputs.vFiberBasisZ 
    );
    // Flip normal based on facing (this is done later in the shader and doesn't work well for fibers so this cancels it out)
    if (fragmentInputs.frontFacing) {
        fiberNormalW = fiberNormalW;
    } else {
        fiberNormalW = -fiberNormalW;
    }
    // Replace the varying vNormalW with the fiber normal
    #define input.vNormalW fiberNormalW
    #define input.vNormalV fiberNormalW
#endif
`;

export const FabricFuzzFragmentBeforeLights = `
#ifdef FABRIC_FUZZ
    // Apply tip color blending
    var tipColor = uniforms.fiberTipColor;
    #ifdef FABRIC_FUZZ_TIP_COLOR_TEXTURE
        #ifdef MAINUV1
            tipColor *= texTipColor;
        #endif
    #endif
    base_color = mix(base_color.rgb, tipColor, fragmentInputs.vFiberUV.y * uniforms.fiberTipColorBlend);
#endif
`;
