#if defined(ENVIRONMENTBRDF) && !defined(REFLECTIONMAP_SKYBOX)
    #if DIELECTRIC_SPECULAR_MODEL == DIELECTRIC_SPECULAR_MODEL_GLTF
        vec3 specularEnvironmentReflectance = getReflectanceFromBRDFLookup(clearcoatOut.specularEnvironmentR0, specularEnvironmentR90, vReflectivityColor.b, environmentBrdf);
    #elif CONDUCTOR_SPECULAR_MODEL == CONDUCTOR_SPECULAR_MODEL_OPENPBR
        vec3 metalReflectance = getF82Specular(NdotV, clearcoatOut.specularEnvironmentR0, vec3(0.0, 1.0, 0.0), reflectivityOut.roughness);
        vec3 specularEnvironmentReflectance = getReflectanceFromBRDFLookup(clearcoatOut.specularEnvironmentR0, clearcoatOut.specularEnvironmentR0, vReflectivityColor.b, environmentBrdf);
        specularEnvironmentReflectance = mix(specularEnvironmentReflectance, metalReflectance, reflectivityOut.metallic);
    #endif

    #ifdef RADIANCEOCCLUSION
        specularEnvironmentReflectance *= seo;
    #endif

    #ifdef HORIZONOCCLUSION
        #ifdef BUMP
            #ifdef REFLECTIONMAP_3D
                specularEnvironmentReflectance *= eho;
            #endif
        #endif
    #endif
#else
    // Jones implementation of a well balanced fast analytical solution.
    vec3 specularEnvironmentReflectance = getReflectanceFromAnalyticalBRDFLookup_Jones(NdotV, clearcoatOut.specularEnvironmentR0, specularEnvironmentR90, sqrt(microSurface));
#endif

#ifdef CLEARCOAT
    specularEnvironmentReflectance *= clearcoatOut.conservationFactor;

    #if defined(CLEARCOAT_TINT)
        specularEnvironmentReflectance *= clearcoatOut.absorption;
    #endif
#endif
