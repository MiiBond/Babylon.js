/**
 * GLSL shader code constants for FabricFuzz plugin material
 * This file contains all the shader code snippets that are injected into shaders
 * when rendering fabric fuzz fibers.
 */

export const FabricFuzzVertexSamplers = `
#ifdef FABRIC_FUZZ
    uniform sampler2D ffPositionSeedTexture;
    uniform sampler2D ffNormalTexture;
    uniform sampler2D ffUVTexture;
    #ifdef FABRIC_FUZZ_TANGENTS
        uniform sampler2D ffTangentTexture;
    #endif
    
    // Fiber parameter textures
    #ifdef FABRIC_FUZZ_DENSITY_TEXTURE
        uniform sampler2D fiberDensityTexture;
    #endif
    #ifdef FABRIC_FUZZ_LENGTH_TEXTURE
        uniform sampler2D fiberLengthTexture;
    #endif
    #ifdef FABRIC_FUZZ_RADIUS_TEXTURE
        uniform sampler2D fiberRadiusTexture;
    #endif
    #ifdef FABRIC_FUZZ_TILT_TEXTURE
        uniform sampler2D fiberTiltTexture;
    #endif
    #ifdef FABRIC_FUZZ_CHAOS_TEXTURE
        uniform sampler2D fiberChaosTexture;
    #endif
    #ifdef FABRIC_FUZZ_CURL_TEXTURE
        uniform sampler2D fiberCurlTexture;
    #endif
    #ifdef FABRIC_FUZZ_TAPER_TEXTURE
        uniform sampler2D fiberTaperTexture;
    #endif
#endif
`;

export const FabricFuzzVertexUniforms = `
#ifdef FABRIC_FUZZ
    // Fiber parameters
    uniform mat4 surfaceMeshToWorld;
    uniform float fiberSegments;
    uniform float fiberLength;
    uniform float fiberLengthVariation;
    uniform float fiberRadius;
    uniform float fiberRotation;
    uniform float fiberRotationVariation;
    uniform float fiberTilt;
    uniform float fiberCurl;
    uniform float fiberChaos;
    uniform float fiberTaper;
    uniform float fiberTaperStart;
    uniform float fiberOffset; // Offset into the instance data textures
#endif
`;

export const FabricFuzzVertexDeclarations = `
#ifdef FABRIC_FUZZ
    // Varyings for passing data to the fragment shader
    varying vec3 vFiberBasisX;
    varying vec3 vFiberBasisZ;
    varying vec2 vFiberUV;
    varying float vTipColorBlend;

    // Read the position or normal for the current instance (gl_InstanceID)
    vec4 readFiberInstanceData(sampler2D dataTexture) {
        // Get the ID of the current instance
        float instanceId = float(gl_InstanceID) + fiberOffset;
        float size = float(textureSize(dataTexture, 0).x);
        
        // Calculate UV coordinate (we are sampling from a 2D texture)
        float u = mod(instanceId, size) / size;
        float v = floor(instanceId / size) / size;

        // Sample the texture.
        return texture2D(dataTexture, vec2(u + 0.5/size, v + 0.5/size)); // Add 0.5/size for pixel center
    }

    #ifndef FABRIC_FUZZ_USE_TANGENT
        /**
         * Robustly creates an orthonormal basis matrix for the fiber instance
         * where the Y-axis (fiber length) is aligned with the surface normal.
         */
        mat3 createOrthoMatrix(vec3 surfaceNormal) {
            // The new Y-axis (fiber length) is the surface Normal
            vec3 newY = surfaceNormal;

            // 1. Calculate a robust X-axis (Tangent)
            // Pick a temporary vector that is NOT parallel to the normal (usually X or Z)
            vec3 tempVector = abs(newY.x) > 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
            
            // Use Gram-Schmidt process to find X-axis perpendicular to Y
            vec3 newX = normalize(cross(newY, tempVector));

            // 2. Calculate the Z-axis (Binormal), which is perpendicular to X and Y
            vec3 newZ = cross(newX, newY);
            
            // 3. Combine Translation, Rotation (Basis), and Scale into the final 4x4 matrix
            mat3 finalMatrix = mat3(1.0);
            finalMatrix[0].xyz = newX;
            finalMatrix[1].xyz = newY; 
            finalMatrix[2].xyz = newZ;

            return finalMatrix;
        }
    #endif
    
    // Random Number Generation
    uint rngState;

    void initRNG(float seed) {
        // Manual float-to-uint conversion for maximum compatibility
        int i = int(seed * 10000.0);
        uint uintSeed = uint(abs(i));
        
        // Mix the bits to improve seed quality
        uintSeed = (uintSeed ^ 61u) ^ (uintSeed >> 16u);
        uintSeed *= 9u;
        uintSeed = uintSeed ^ (uintSeed >> 4u);
        uintSeed *= 0x27d4eb2du;
        uintSeed = uintSeed ^ (uintSeed >> 15u);
        
        rngState = uintSeed;
    }

    uint randUint() {
        // Linear Congruential Generator (same constants as glibc)
        const uint LCG_A = 1664525u;
        const uint LCG_C = 1013904223u;
        rngState = (LCG_A * rngState + LCG_C);
        return rngState;
    }

    float randFloat() {
        const float RCP_UINT_MAX = 2.3283064365386963e-10; // 1.0 / (2^32)
        return float(randUint()) * RCP_UINT_MAX;
    }
#endif
`;

export const FabricFuzzVertexMainBegin = `
#ifdef FABRIC_FUZZ
    // Read data for the current instance
    vec4 positionSeedData = readFiberInstanceData(ffPositionSeedTexture);
    vec3 ffSurfaceNormal = readFiberInstanceData(ffNormalTexture).xyz;
    vec4 ffSurfaceUVData = readFiberInstanceData(ffUVTexture);
    #ifdef FABRIC_FUZZ_TANGENTS
        vec4 tangentData = readFiberInstanceData(ffTangentTexture);
    #endif
#endif
`;

export const FabricFuzzVertexUpdateWorldPos = `
#ifdef FABRIC_FUZZ
    vec3 rootPos = positionSeedData.xyz;
    float seed = positionSeedData.w;
    initRNG(seed);

    #ifdef MAINUV1
        vec2 ffSurfaceUV1 = ffSurfaceUVData.xy;
    #endif
    #ifdef MAINUV2
        vec2 ffSurfaceUV2 = ffSurfaceUVData.zw;
    #endif
    
    // Sample parameter textures to modulate fiber properties
    float texDensity = 1.0;
    float texLength = 1.0;
    float texRadius = 1.0;
    float texTilt = 1.0;
    float texChaos = 1.0;
    float texCurl = 1.0;
    float texTaper = 1.0;
    float texTipColorBlend = 1.0;
    
    #ifdef FABRIC_FUZZ_DENSITY_TEXTURE
        #ifdef MAINUV1
            texDensity = texture2D(fiberDensityTexture, ffSurfaceUV1).r;
        #endif
    #endif
    #ifdef FABRIC_FUZZ_LENGTH_TEXTURE
        #ifdef MAINUV1
            texLength = texture2D(fiberLengthTexture, ffSurfaceUV1).r;
        #endif
    #endif
    #ifdef FABRIC_FUZZ_RADIUS_TEXTURE
        #ifdef MAINUV1
            texRadius = texture2D(fiberRadiusTexture, ffSurfaceUV1).r;
        #endif
    #endif
    #ifdef FABRIC_FUZZ_TILT_TEXTURE
        #ifdef MAINUV1
            texTilt = texture2D(fiberTiltTexture, ffSurfaceUV1).r;
        #endif
    #endif
    #ifdef FABRIC_FUZZ_CHAOS_TEXTURE
        #ifdef MAINUV1
            texChaos = texture2D(fiberChaosTexture, ffSurfaceUV1).r;
        #endif
    #endif
    #ifdef FABRIC_FUZZ_CURL_TEXTURE
        #ifdef MAINUV1
            texCurl = texture2D(fiberCurlTexture, ffSurfaceUV1).r;
        #endif
    #endif
    #ifdef FABRIC_FUZZ_TAPER_TEXTURE
        #ifdef MAINUV1
            texTaper = texture2D(fiberTaperTexture, ffSurfaceUV1).r;
        #endif
    #endif
    
    // Apply texture modulation to parameters
    float modifiedLength = fiberLength * texLength;
    float modifiedRadius = fiberRadius * texRadius;
    float modifiedTilt = fiberTilt * texTilt;
    float modifiedChaos = fiberChaos * texChaos;
    float modifiedCurl = fiberCurl * texCurl;
    float modifiedTaper = fiberTaper * texTaper;
    
    #ifdef FABRIC_FUZZ_TANGENTS
        vFiberBasisX = tangentData.xyz;
        vFiberBasisZ = cross(ffSurfaceNormal, vFiberBasisX) * tangentData.w;
    #else
        {
        mat3 instanceMatrix = createOrthoMatrix(ffSurfaceNormal);
        vFiberBasisX = instanceMatrix[0].xyz; 
        vFiberBasisZ = instanceMatrix[2].xyz;
        }
    #endif

    // Compute starting direction (tilt + rotation)
    // Apply rotation variation
    float baseRotationAngle = fiberRotation * TWO_PI;
    float rotationOffset = (randFloat() - 0.5) * fiberRotationVariation * TWO_PI;
    float finalRotationAngle = baseRotationAngle + rotationOffset;
    
    // Rotate tangent around normal
    vec3 rotatedTangent = vFiberBasisX * cos(finalRotationAngle) + 
                        vFiberBasisZ * sin(finalRotationAngle);
    vec3 rotatedBitangent = cross(ffSurfaceNormal, rotatedTangent);
    
    // Apply tilt (angle away from normal toward tangent)
    float tiltAngle = modifiedTilt * HALF_PI;
    vec3 fiberDirection = ffSurfaceNormal * cos(tiltAngle) + 
                        rotatedTangent * sin(tiltAngle);
    fiberDirection = normalize(vec4(fiberDirection, 0.0) * transpose(surfaceMeshToWorld)).xyz;

    // Extract triangle strip information
    // For a triangle strip: 
    // - The fiber's is 1 unit high so the progress along fiber is position.y (0=root, 1=tip)
    // - position.x is the signed offset from center (-1 to +1)
    float vertexProgress = positionUpdated.y;
    
    uint vertexIndex = uint(vertexProgress * fiberSegments);
    
    // Strip width parameter: -1 = left edge, 0 = center, +1 = right edge
    float stripOffset = positionUpdated.x;  // Assumes strip is in XY plane, offset in X
    
    // Calculate deformed spine position at this vertex
    float baseSegmentLength = modifiedLength / fiberSegments;
    
    vec3 spinePosition = (surfaceMeshToWorld * vec4(rootPos, 1.0)).xyz;
    vec3 currentDirection = fiberDirection;
    
    vec3 stableRight = rotatedTangent;
    vec3 stableBitangent = rotatedBitangent;
    
    float curlAnglePerSegment = modifiedCurl * PI / max(1.0, fiberSegments - 1.0);
    float maxChaosAnglePerSegment = modifiedChaos * HALF_PI;
    
    // Walk through segments up to current vertex
    for (uint seg = 0u; seg < vertexIndex; seg++) {
        vec3 prevDirection = currentDirection;
        
        float segmentLengthVariation = (randFloat() - 0.5) * fiberLengthVariation * baseSegmentLength * 2.0;
        float segmentLength = baseSegmentLength + segmentLengthVariation;
        
        if (curlAnglePerSegment > 0.0) {
            vec3 curlAxis = normalize(cross(currentDirection, stableBitangent));
            currentDirection = currentDirection * cos(curlAnglePerSegment) - 
                            curlAxis * sin(curlAnglePerSegment);
            currentDirection = normalize(currentDirection);
        }
        
        if (maxChaosAnglePerSegment > 0.0) {
            float cosMaxChaos = cos(maxChaosAnglePerSegment);
            float cosChaos = cosMaxChaos + (1.0 - cosMaxChaos) * randFloat();
            float sinChaos = sqrt(1.0 - cosChaos * cosChaos);
            float azimuth = TWO_PI * randFloat();
            
            vec3 perpendicular1 = normalize(cross(currentDirection, stableBitangent));
            if (length(perpendicular1) < 0.01) {
                perpendicular1 = normalize(cross(currentDirection, vec3(0, 1, 0)));
                if (length(perpendicular1) < 0.01) {
                    perpendicular1 = normalize(cross(currentDirection, vec3(1, 0, 0)));
                }
            }
            vec3 perpendicular2 = cross(currentDirection, perpendicular1);
            
            currentDirection = currentDirection * cosChaos + 
                            perpendicular1 * sinChaos * sin(azimuth) +
                            perpendicular2 * sinChaos * cos(azimuth);
            currentDirection = normalize(currentDirection);
        }
        
        // Parallel transport
        vec3 rotationAxis = cross(prevDirection, currentDirection);
        float rotationAxisLength = length(rotationAxis);
        
        if (rotationAxisLength > 0.0001) {
            rotationAxis = rotationAxis / rotationAxisLength;
            float rotationAngle = asin(min(1.0, rotationAxisLength));
            float cosAngle = cos(rotationAngle);
            float sinAngle = sin(rotationAngle);
            
            vec3 newStableRight = stableRight * cosAngle + 
                                cross(rotationAxis, stableRight) * sinAngle + 
                                rotationAxis * dot(rotationAxis, stableRight) * (1.0 - cosAngle);
            
            vec3 newStableBitangent = stableBitangent * cosAngle + 
                                    cross(rotationAxis, stableBitangent) * sinAngle + 
                                    rotationAxis * dot(rotationAxis, stableBitangent) * (1.0 - cosAngle);
            
            stableRight = normalize(newStableRight);
            stableBitangent = normalize(newStableBitangent);
        }
        
        spinePosition += currentDirection * segmentLength;
    }

    // Apply tapering to radius based on vertex progress
    float taperProgress = max(0.0, vertexProgress - fiberTaperStart);
    float taperScale = 1.0 - (taperProgress / max(0.001, 1.0 - fiberTaperStart)) * modifiedTaper;
    float currentRadius = modifiedRadius * taperScale;
    
    // Orient strip to face camera (billboard effect)
    vec3 fiberForward = normalize(currentDirection);
    
    // Compute direction from spine to camera
    vec3 toCamera = normalize(vEyePosition.xyz - spinePosition);
    
    // Strip right direction is perpendicular to both fiber forward and to-camera
    vec3 stripRight = normalize(cross(fiberForward, toCamera));
    
    vFiberBasisX = stripRight;
    vFiberBasisZ = -cross(fiberForward, stripRight);
    vFiberUV = vec2(stripOffset, vertexProgress);

    // Position vertex along strip width     
    vec3 finalPosition = spinePosition + stripRight * stripOffset * currentRadius;
    // Transform local position to world space
    worldPos = vec4(finalPosition, 1.0);
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
        vMainUV1 = ffSurfaceUV1;
    #endif
    #ifdef MAINUV2
        // Use the surface UV as the base
        vMainUV2 = ffSurfaceUV2;
    #endif
#endif
`;

export const FabricFuzzFragmentDeclarations = `
#ifdef FABRIC_FUZZ
    #ifdef FABRIC_FUZZ_TIP_COLOR_TEXTURE
        uniform sampler2D fiberTipColorTexture;
    #endif
    varying vec3 vFiberBasisX;
    varying vec3 vFiberBasisZ;
    varying vec2 vFiberUV;
#endif
`;

export const FabricFuzzFragmentMainBegin = `
#ifdef FABRIC_FUZZ

    #ifdef FABRIC_FUZZ_TIP_COLOR_TEXTURE
        #ifdef MAINUV1
            float texTipColor = texture2D(fiberTipColorTexture, vMainUV1).r;
        #endif
    #endif
    // Compute lighting based on fiber orientation
    float localX = cos(PI * vFiberUV.x - HALF_PI);
    vec3 localCylinderNormal = normalize(vec3(localX, 0.0, 1.0 - abs(localX)));

    // 2. Transform the local normal to world space using the interpolated basis vectors (TBN)
    // Since the local normal only has X and Z components (in local hair space):
    vec3 fiberNormalW = normalize(
        localCylinderNormal.x * vFiberBasisX +
        localCylinderNormal.z * vFiberBasisZ 
    );
    // Flip normal based on facing (this is done later in the shader and doesn't work well for fibers so this cancels it out)
    fiberNormalW = gl_FrontFacing ? fiberNormalW : -fiberNormalW;
    // Replace the varying vNormalW with the fiber normal
    #define vNormalW fiberNormalW
    #define vNormalV fiberNormalW
#endif
`;

export const FabricFuzzFragmentBeforeLights = `
#ifdef FABRIC_FUZZ
    // Apply tip color blending
    vec3 tipColor = fiberTipColor;
    #ifdef FABRIC_FUZZ_TIP_COLOR_TEXTURE
        #ifdef MAINUV1
            tipColor *= texTipColor;
        #endif
    #endif
    base_color = mix(base_color.rgb, tipColor, sqrt(vFiberUV.y) * fiberTipColorBlend);
#endif
`;
