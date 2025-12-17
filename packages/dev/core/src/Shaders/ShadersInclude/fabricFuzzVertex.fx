#ifdef FABRIC_FUZZ
    vec3 rootPos = positionSeedData.xyz;
    float seed = positionSeedData.w;
    initRNG(seed);
    vec3 ffSurfaceNormal = vec3(normalUVData.x, normalUVData.y, 1.0 - length(normalUVData.xy));
    ffSurfaceUV = vec2(normalUVData.z, normalUVData.w);
    #ifdef FABRIC_FUZZ_TANGENTS
        vec4 tangentData = readInstanceData(ffTangentTexture);
        vBasisX = tangentData.xyz;
        vBasisZ = cross(ffSurfaceNormal, vBasisX) * tangentData.w;
    #else
        {
        mat4 instanceMatrix = createOrthoMatrix(ffSurfaceNormal);
        vBasisX = instanceMatrix[0].xyz; 
        vBasisZ = instanceMatrix[2].xyz;
        }
    #endif

    // Compute starting direction (tilt + rotation)
    // Apply rotation variation
    float baseRotationAngle = fiberRotation * TWO_PI;
    float rotationOffset = (randFloat() - 0.5) * fiberRotationVariation * TWO_PI;
    float finalRotationAngle = baseRotationAngle + rotationOffset;
    
    // Rotate tangent around normal
    vec3 rotatedTangent = vBasisX * cos(finalRotationAngle) + 
                        vBasisZ * sin(finalRotationAngle);
    vec3 rotatedBitangent = cross(surfaceNormal, rotatedTangent);
    
    // Apply tilt (angle away from normal toward tangent)
    float tiltAngle = fiberTilt * HALF_PI;
    vec3 fiberDirection = surfaceNormal * cos(tiltAngle) + 
                        rotatedTangent * sin(tiltAngle);
    fiberDirection = normalize(fiberDirection);

    // Extract triangle strip information
    // For a triangle strip: 
    // - The fiber's uv.y is progress along fiber (0=root, 1=tip)
    // - The fiber's uv.x indicates which side of strip (0=left, 1=right)
    // - position.x is the signed offset from center (-1 to +1)
    
    float vertexProgress = uvUpdated.y;
    uint vertexIndex = uint(vertexProgress * float(fiberSegments));
    
    // Strip width parameter: -1 = left edge, 0 = center, +1 = right edge
    float stripOffset = positionUpdated.x;  // Assumes strip is in XY plane, offset in X
    
    // Calculate deformed spine position at this vertex
    float baseSegmentLength = fiberLength / float(fiberSegments);
    
    vec3 spinePosition = rootPos;
    vec3 currentDirection = fiberDirection;
    
    vec3 stableRight = rotatedTangent;
    vec3 stableBitangent = rotatedBitangent;
    
    float curlAnglePerSegment = fiberCurl * PI / max(1.0, float(fiberSegments) - 1.0);
    float maxChaosAnglePerSegment = fiberChaos * HALF_PI;
    
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
    float taperScale = 1.0 - (taperProgress / max(0.001, 1.0 - fiberTaperStart)) * fiberTaper;
    float currentRadius = fiberRadius * taperScale;
    
    // Orient strip to face camera (billboard effect)
    vec3 fiberForward = normalize(currentDirection);
    
    // Compute direction from spine to camera
    vec3 toCamera = normalize(vEyePosition.xyz - spinePosition);
    
    // Strip right direction is perpendicular to both fiber forward and to-camera
    vec3 stripRight = normalize(cross(fiberForward, toCamera));
    
    vBasisX = stripRight;
    vBasisZ = toCamera;

    // Position vertex along strip width     
    vec3 finalPosition = spinePosition + stripRight * stripOffset * currentRadius;
    // Transform local position to world space
    vec4 worldPos = vec4(finalPosition, 1.0);
#endif
