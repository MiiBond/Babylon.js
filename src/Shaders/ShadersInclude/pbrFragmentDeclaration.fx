uniform vec3 vReflectionColor;
uniform vec4 vAlbedoColor;

uniform float opticalTransmission;

// CUSTOM CONTROLS
uniform vec4 vLightingIntensity;

uniform vec4 vReflectivityColor;
uniform vec3 vEmissiveColor;

// Samplers
#ifdef ALBEDO
uniform vec2 vAlbedoInfos;
#endif

#ifdef AMBIENT
uniform vec4 vAmbientInfos;
#endif

#ifdef BUMP
uniform vec3 vBumpInfos;
uniform vec2 vTangentSpaceParams;
#endif

#ifdef OPACITY	
uniform vec2 vOpacityInfos;
#endif

#ifdef TRANSMISSION	
uniform vec2 vTransmissionInfos;
#endif

#ifdef INTERIORCOLOR
    uniform vec3 interiorColor;
    uniform float interiorDensity;
#endif

#ifdef EMISSIVE
uniform vec2 vEmissiveInfos;
#endif

#ifdef LIGHTMAP
uniform vec2 vLightmapInfos;
#endif

#ifdef REFLECTIVITY
uniform vec3 vReflectivityInfos;
#endif

#ifdef MICROSURFACEMAP
uniform vec2 vMicroSurfaceSamplerInfos;
#endif

// Refraction Reflection
#if defined(REFLECTIONMAP_SPHERICAL) || defined(REFLECTIONMAP_PROJECTION) || defined(REFRACTION) || defined(SCENETEXTURE)
uniform mat4 view;
#endif

// Refraction
#ifdef REFRACTION
    uniform vec4 vRefractionInfos;
    uniform mat4 refractionMatrix;
    uniform vec3 vRefractionMicrosurfaceInfos;

    #ifdef SCENETEXTURE
        uniform mat4 sceneRefractionMatrix;
        uniform vec4 vSceneRefractionInfos;
        uniform vec3 vSceneRefractionMicrosurfaceInfos;
        uniform vec2 cameraMinMaxZ;
    #endif
#endif

// Reflection
#ifdef REFLECTION
    uniform vec2 vReflectionInfos;
    uniform mat4 reflectionMatrix;
    uniform vec3 vReflectionMicrosurfaceInfos;

    #if defined(USE_LOCAL_REFLECTIONMAP_CUBIC) && defined(REFLECTIONMAP_CUBIC)
	    uniform vec3 vReflectionPosition;
	    uniform vec3 vReflectionSize; 
    #endif
#endif