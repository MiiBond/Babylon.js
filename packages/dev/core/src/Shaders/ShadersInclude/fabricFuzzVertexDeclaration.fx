#ifdef FABRIC_FUZZ
    // Varyings for passing data to the fragment shader
    varying vec3 vFiberBasisX;
    varying vec3 vFiberBasisZ;

    // Read the position or normal for the current instance (gl_InstanceID)
    vec4 readFiberInstanceData(sampler2D dataTexture) {
        // Get the ID of the current instance
        float instanceId = float(gl_InstanceID);
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
