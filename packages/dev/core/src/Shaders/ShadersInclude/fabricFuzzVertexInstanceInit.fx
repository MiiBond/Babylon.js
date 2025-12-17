#ifdef FABRIC_FUZZ
	// Read data for the current instance
    vec4 positionSeedData = readInstanceData(ffPositionSeedTexture);
    vec4 normalUVData = readInstanceData(ffNormalUVTexture);
    #ifdef FABRIC_FUZZ_TANGENTS
        vec4 tangentData = readInstanceData(ffTangentTexture);
    #endif
#endif
