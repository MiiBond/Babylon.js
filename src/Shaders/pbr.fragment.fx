#ifdef ADOBE_TRANSPARENCY_G_BUFFER
    #extension GL_EXT_draw_buffers : require
#endif

#if defined(BUMP) || !defined(NORMAL) || defined(FORCENORMALFORWARD) || defined(SPECULARAA) || defined(CLEARCOAT_BUMP) || defined(ANISOTROPIC)
#extension GL_OES_standard_derivatives : enable
#endif

#ifdef LODBASEDMICROSFURACE
#extension GL_EXT_shader_texture_lod : enable
#endif

#define CUSTOM_FRAGMENT_BEGIN

#ifdef LOGARITHMICDEPTH
#extension GL_EXT_frag_depth : enable
#endif

precision highp float;

// Forces linear space for image processing
#ifndef FROMLINEARSPACE
    #define FROMLINEARSPACE
#endif

#ifdef ADOBE_TRANSPARENCY_G_BUFFER
    #include<mrtFragmentDeclaration>[ADOBE_TRANSPARENCY_G_BUFFER_LENGTH]
#endif

// Declaration
#include<__decl__pbrFragment>
#include<pbrFragmentExtraDeclaration>
#include<__decl__lightFragment>[0..maxSimultaneousLights]
#include<pbrFragmentSamplersDeclaration>
#include<imageProcessingDeclaration>
#include<clipPlaneFragmentDeclaration>
#include<logDepthDeclaration>
#include<fogFragmentDeclaration>

// Helper Functions
#include<helperFunctions>
#include<pbrHelperFunctions>
#include<imageProcessingFunctions>
#include<shadowsFragmentFunctions>
#include<harmonicsFunctions>
#include<pbrDirectLightingSetupFunctions>
#include<pbrDirectLightingFalloffFunctions>
#include<pbrBRDFFunctions>
#include<pbrDirectLightingFunctions>
#include<pbrIBLFunctions>
#include<bumpFragmentFunctions>

#ifdef REFLECTION
    #include<reflectionFunction>
#endif

#define CUSTOM_FRAGMENT_DEFINITIONS

// _____________________________ MAIN FUNCTION ____________________________
void main(void) {

    #define CUSTOM_FRAGMENT_MAIN_BEGIN

    #include<clipPlaneFragment>

// _____________________________ Geometry Information ____________________________
    vec3 viewDirectionW = normalize(vEyePosition.xyz - vPositionW);

#ifdef NORMAL
    vec3 normalW = normalize(vNormalW);
#else
    vec3 normalW = normalize(cross(dFdx(vPositionW), dFdy(vPositionW))) * vEyePosition.w;
#endif

#if defined(DEPTH_PEELING) || defined(SS_DEPTHINREFRACTIONALPHA)
    float sceneDepthWorld = gl_FragCoord.z * 2. - 1.; // Depth range being 0 to 1 -> transform to -1 - 1
    sceneDepthWorld = sceneDepthWorld / gl_FragCoord.w; // Revert to the projection space z
    float sceneDepthNormalized = (sceneDepthWorld + depthValues.x) / depthValues.y; // Apply camera setup to transform back to 0 - 1 but in a linear way
    #ifdef DEPTH_PEELING
        sceneDepthNormalized -= Epsilon;
    #endif
#endif

#ifdef DEPTH_PEELING
    #ifdef DEPTH_PEELING_FRONT
        // Handle depth-peeling against current depth textures.
        vec2 screenCoords = vec2(gl_FragCoord.x / depthValues.z, gl_FragCoord.y / depthValues.w);
        #ifdef DEPTH_PEELING_FRONT_INVERSE
            float frontDepth = 1.0 - texture2D(frontDepthTexture, screenCoords).a + Epsilon;
        #else
            float frontDepth = texture2D(frontDepthTexture, screenCoords).r;
        #endif
        if (frontDepth >= sceneDepthNormalized) {
            discard;
        }
        #ifdef DEPTH_PEELING_BACK
            float backDepth = texture2D(backDepthTexture, screenCoords).r;
            if (backDepth <= sceneDepthNormalized) {
                discard;
            }
        #endif
    #endif
#endif

#ifdef CLEARCOAT
    // Needs to use the geometric normal before bump for this.
    vec3 clearCoatNormalW = normalW;
#endif

#include<bumpFragment>

#if defined(FORCENORMALFORWARD) && defined(NORMAL)
    vec3 faceNormal = normalize(cross(dFdx(vPositionW), dFdy(vPositionW))) * vEyePosition.w;
    #if defined(TWOSIDEDLIGHTING)
        faceNormal = gl_FrontFacing ? faceNormal : -faceNormal;
    #endif

    normalW *= sign(dot(normalW, faceNormal));
#endif

#if defined(TWOSIDEDLIGHTING) && defined(NORMAL)
    normalW = gl_FrontFacing ? normalW : -normalW;
#endif

// _____________________________ Albedo Information ______________________________
    // Albedo
    vec3 surfaceAlbedo = vAlbedoColor.rgb;

    // Alpha
    float alpha = vAlbedoColor.a;

#ifdef ALBEDO
    vec4 albedoTexture = texture2D(albedoSampler, vAlbedoUV + uvOffset);
    #if defined(ALPHAFROMALBEDO) || defined(ALPHATEST)
        alpha *= albedoTexture.a;
    #endif

    #ifdef GAMMAALBEDO
        surfaceAlbedo *= toLinearSpace(albedoTexture.rgb);
    #else
        surfaceAlbedo *= albedoTexture.rgb;
    #endif

    surfaceAlbedo *= vAlbedoInfos.y;
#endif

#ifdef VERTEXCOLOR
    surfaceAlbedo *= vColor.rgb;
#endif

#define CUSTOM_FRAGMENT_UPDATE_ALBEDO

// _____________________________ Alpha Information _______________________________
#ifdef OPACITY
    vec4 opacityMap = texture2D(opacitySampler, vOpacityUV + uvOffset);

    #ifdef OPACITYRGB
        alpha = getLuminance(opacityMap.rgb);
    #else
        alpha *= opacityMap.a;
    #endif

    alpha *= vOpacityInfos.y;
#endif

#ifdef VERTEXALPHA
    alpha *= vColor.a;
#endif

#if !defined(SS_LINKREFRACTIONTOTRANSPARENCY) && !defined(ALPHAFRESNEL)
    #ifdef ALPHATEST
        if (alpha < ALPHATESTVALUE)
            discard;

        #ifndef ALPHABLEND
            // Prevent to blend with the canvas.
            alpha = 1.0;
        #endif
    #endif
#endif

#define CUSTOM_FRAGMENT_UPDATE_ALPHA

#include<depthPrePass>

#define CUSTOM_FRAGMENT_BEFORE_LIGHTS

// _____________________________ AO    Information _______________________________
    vec3 ambientOcclusionColor = vec3(1., 1., 1.);

#ifdef AMBIENT
    vec3 ambientOcclusionColorMap = texture2D(ambientSampler, vAmbientUV + uvOffset).rgb * vAmbientInfos.y;
    #ifdef AMBIENTINGRAYSCALE
        ambientOcclusionColorMap = vec3(ambientOcclusionColorMap.r, ambientOcclusionColorMap.r, ambientOcclusionColorMap.r);
    #endif
    ambientOcclusionColor = mix(ambientOcclusionColor, ambientOcclusionColorMap, vAmbientInfos.z);
#endif

#ifdef UNLIT
    vec3 diffuseBase = vec3(1., 1., 1.);
#else
    // _____________________________ Reflectivity Info _______________________________
    float microSurface = vReflectivityColor.a;
    vec3 surfaceReflectivityColor = vReflectivityColor.rgb;

    #ifdef METALLICWORKFLOW
        vec2 metallicRoughness = surfaceReflectivityColor.rg;

        #ifdef REFLECTIVITY
            vec4 surfaceMetallicColorMap = texture2D(reflectivitySampler, vReflectivityUV + uvOffset);

            #ifdef AOSTOREINMETALMAPRED
                vec3 aoStoreInMetalMap = vec3(surfaceMetallicColorMap.r, surfaceMetallicColorMap.r, surfaceMetallicColorMap.r);
                ambientOcclusionColor = mix(ambientOcclusionColor, aoStoreInMetalMap, vReflectivityInfos.z);
            #endif

            #ifdef METALLNESSSTOREINMETALMAPBLUE
                metallicRoughness.r *= surfaceMetallicColorMap.b;
            #else
                metallicRoughness.r *= surfaceMetallicColorMap.r;
            #endif

            #ifdef ROUGHNESSSTOREINMETALMAPALPHA
                metallicRoughness.g *= surfaceMetallicColorMap.a;
            #else
                #ifdef ROUGHNESSSTOREINMETALMAPGREEN
                    metallicRoughness.g *= surfaceMetallicColorMap.g;
                #endif
            #endif
        #endif

        #ifdef MICROSURFACEMAP
            vec4 microSurfaceTexel = texture2D(microSurfaceSampler, vMicroSurfaceSamplerUV + uvOffset) * vMicroSurfaceSamplerInfos.y;
            metallicRoughness.g *= microSurfaceTexel.r;
        #endif

        #define CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS
		
        // Compute microsurface from roughness.
        microSurface = 1.0 - metallicRoughness.g;

        // Diffuse is used as the base of the reflectivity.
        vec3 baseColor = surfaceAlbedo;

        #ifdef REFLECTANCE
            // Following Frostbite Remapping,
            // https://seblagarde.files.wordpress.com/2015/07/course_notes_moving_frostbite_to_pbr_v32.pdf page 115
            // vec3 f0 = 0.16 * reflectance * reflectance * (1.0 - metallic) + baseColor * metallic;
            // where 0.16 * reflectance * reflectance remaps the reflectance to allow storage in 8 bit texture

            // Compute the converted diffuse.
            surfaceAlbedo = baseColor.rgb * (1.0 - metallicRoughness.r);

            // Compute the converted reflectivity.
            surfaceReflectivityColor = mix(0.16 * reflectance * reflectance, baseColor, metallicRoughness.r);
        #else
            vec3 metallicF0 = vec3(vReflectivityColor.a, vReflectivityColor.a, vReflectivityColor.a);
            #ifdef METALLICF0FACTORFROMMETALLICMAP
                #ifdef REFLECTIVITY
                    metallicF0 *= surfaceMetallicColorMap.a;
                #endif
            #endif

            // Compute the converted diffuse.
            surfaceAlbedo = mix(baseColor.rgb * (1.0 - metallicF0.r), vec3(0., 0., 0.), metallicRoughness.r);

            // Compute the converted reflectivity.
            surfaceReflectivityColor = mix(metallicF0, baseColor, metallicRoughness.r);
        #endif
    #else
        #ifdef REFLECTIVITY
            vec4 surfaceReflectivityColorMap = texture2D(reflectivitySampler, vReflectivityUV + uvOffset);
            surfaceReflectivityColor *= toLinearSpace(surfaceReflectivityColorMap.rgb);
            surfaceReflectivityColor *= vReflectivityInfos.y;

            #ifdef MICROSURFACEFROMREFLECTIVITYMAP
                microSurface *= surfaceReflectivityColorMap.a;
                microSurface *= vReflectivityInfos.z;
            #else
                #ifdef MICROSURFACEAUTOMATIC
                    microSurface *= computeDefaultMicroSurface(microSurface, surfaceReflectivityColor);
                #endif

                #ifdef MICROSURFACEMAP
                    vec4 microSurfaceTexel = texture2D(microSurfaceSampler, vMicroSurfaceSamplerUV + uvOffset) * vMicroSurfaceSamplerInfos.y;
                    microSurface *= microSurfaceTexel.r;
                #endif
				
                #define CUSTOM_FRAGMENT_UPDATE_MICROSURFACE
				
            #endif
        #endif
    #endif
	
	// Adapt microSurface.
    microSurface = saturate(microSurface);
    // Compute roughness.
    float roughness = 1. - microSurface;

    // _____________________________ Alpha Fresnel ___________________________________
    #ifdef ALPHAFRESNEL
        #if defined(ALPHATEST) || defined(ALPHABLEND)
            // Convert approximate perceptual opacity (gamma-encoded opacity) to linear opacity (absorptance, or inverse transmission)
            // for use with the linear HDR render target. The final composition will be converted back to gamma encoded values for eventual display.
            // Uses power 2.0 rather than 2.2 for simplicity/efficiency, and because the mapping does not need to map the gamma applied to RGB.
            float opacityPerceptual = alpha;

            #ifdef LINEARALPHAFRESNEL
                float opacity0 = opacityPerceptual;
            #else
                float opacity0 = opacityPerceptual * opacityPerceptual;
            #endif
            float opacity90 = fresnelGrazingReflectance(opacity0);

            vec3 normalForward = faceforward(normalW, -viewDirectionW, normalW);

            // Calculate the appropriate linear opacity for the current viewing angle (formally, this quantity is the "directional absorptance").
            alpha = getReflectanceFromAnalyticalBRDFLookup_Jones(saturate(dot(viewDirectionW, normalForward)), vec3(opacity0), vec3(opacity90), sqrt(microSurface)).x;

            #ifdef ALPHATEST
                if (alpha < ALPHATESTVALUE)
                    discard;

                #ifndef ALPHABLEND
                    // Prevent to blend with the canvas.
                    alpha = 1.0;
                #endif
            #endif
        #endif
    #endif

    // _____________________________ Compute Geometry info _________________________________
    float NdotVUnclamped = dot(normalW, viewDirectionW);
    // The order 1886 page 3.
    float NdotV = absEps(NdotVUnclamped);
    float alphaG = convertRoughnessToAverageSlope(roughness);
    vec2 AARoughnessFactors = getAARoughnessFactors(normalW.xyz);

    #ifdef SPECULARAA
        // Adapt linear roughness (alphaG) to geometric curvature of the current pixel.
        alphaG += AARoughnessFactors.y;
    #endif

    #ifdef ANISOTROPIC
        float anisotropy = vAnisotropy.b;
        vec3 anisotropyDirection = vec3(vAnisotropy.xy, 0.);

        #ifdef ANISOTROPIC_TEXTURE
            vec3 anisotropyMapData = texture2D(anisotropySampler, vAnisotropyUV + uvOffset).rgb * vAnisotropyInfos.y;
            anisotropy *= anisotropyMapData.b;
            anisotropyDirection.rg *= anisotropyMapData.rg * 2.0 - 1.0;
        #endif

        mat3 anisoTBN = mat3(normalize(TBN[0]), normalize(TBN[1]), normalize(TBN[2]));
        vec3 anisotropicTangent = normalize(anisoTBN * anisotropyDirection);
        vec3 anisotropicBitangent = normalize(cross(anisoTBN[2], anisotropicTangent));
        
        vec3 anisotropicNormal = getAnisotropicBentNormals(anisotropicTangent, anisotropicBitangent, normalW, viewDirectionW, anisotropy);
    #endif

    // Add param to control whether albedo is used for constant tint
    // TintColor and Tint at Distance is used for volume tint
    #if defined(SUBSURFACE) || defined(SS_REFRACTION)
        float thickness = 0.0;
        float thicknessNormalized = 0.0;
    #endif

    // _____________________________ Refraction Info _______________________________________
    #ifdef SS_REFRACTION
        vec4 environmentRefraction = vec4(0., 0., 0., 0.);

        #ifdef ANISOTROPIC
            vec3 refractionVector = refract(-viewDirectionW, anisotropicNormal, vRefractionInfos.y);
        #else
            vec3 refractionVector = refract(-viewDirectionW, normalW, vRefractionInfos.y);
        #endif

        #ifdef SS_REFRACTIONMAP_OPPOSITEZ
            refractionVector.z *= -1.0;
        #endif

        // If we're using either alpha blending or we have access to refraction depth,
        // we'll also need to sample the unrefracted scene render.
        #if !defined(SS_REFRACTIONMAP_3D)

            mat4 refractViewMatrix = refractionMatrix * view;
            vec3 vNoRefractionUVW = vec3(refractViewMatrix * vec4(vPositionW, 1.0));
            vec2 refractionCoordsNoRefract = vNoRefractionUVW.xy / vNoRefractionUVW.z;
            refractionCoordsNoRefract.y = 1.0 - refractionCoordsNoRefract.y;
            vec4 refraction_clear = sampleRefraction(refractionSampler, refractionCoordsNoRefract).rgba;
            #if defined(SS_DEPTHINREFRACTIONALPHA) || defined(ALPHABLEND)
                
                #if defined(SS_VOLUME_THICKNESS) && !defined(ADOBE_TRANSPARENCY_G_BUFFER)
                    // To avoid artifacts from the lower-res refraction depth, we will take a bunch of samples and select the one
                    // that gives the smallest thickness while still being positive.
                    float refractionDepth = (1.0 - refraction_clear.a);
                    thicknessNormalized = clamp(refractionDepth - sceneDepthNormalized, 0.0, 1.0);
                    // Convert thickness to be in world units. Bump up by small amount to avoid 0 in thickness calculations.
                    thickness = (thicknessNormalized + 0.0001) * depthValues.y - depthValues.x;
                #endif
            #endif
        #endif

        // _____________________________ 2D vs 3D Maps ________________________________
        #ifdef SS_REFRACTIONMAP_3D
            refractionVector.y = refractionVector.y * vRefractionInfos.w;
            vec3 refractionCoords = refractionVector;
            refractionCoords = vec3(refractionMatrix * vec4(refractionCoords, 0));
        #elif defined(SS_VOLUME_THICKNESS) && defined(SS_DEPTHINREFRACTIONALPHA)
            vec3 vRefractionUVW = vec3(refractViewMatrix * vec4(vPositionW + refractionVector * vRefractionInfos.z * thicknessNormalized, 1.0));
            vec2 refractionCoords = vRefractionUVW.xy / vRefractionUVW.z;
            refractionCoords.y = 1.0 - refractionCoords.y;
        #else
            vec3 vRefractionUVW = vec3(refractViewMatrix * vec4(vPositionW + refractionVector * vRefractionInfos.z, 1.0));
            vec2 refractionCoords = vRefractionUVW.xy / vRefractionUVW.z;
            refractionCoords.y = 1.0 - refractionCoords.y;
        #endif

        #ifdef SS_LODINREFRACTIONALPHA
            float refractionLOD = getLodFromAlphaG(vRefractionMicrosurfaceInfos.x, alphaG, NdotVUnclamped);
        #elif defined(SS_LINEARSPECULARREFRACTION)
            float refractionLOD = getLinearLodFromRoughness(vRefractionMicrosurfaceInfos.x, roughness);
        #else
            float refractionLOD = getLodFromAlphaG(vRefractionMicrosurfaceInfos.x, alphaG);
        #endif

        #ifdef LODBASEDMICROSFURACE
            // Apply environment convolution scale/offset filter tuning parameters to the mipmap LOD selection
            refractionLOD = refractionLOD * vRefractionMicrosurfaceInfos.y + vRefractionMicrosurfaceInfos.z;

            #ifdef SS_LODINREFRACTIONALPHA
                // Automatic LOD adjustment to ensure that the smoothness-based environment LOD selection
                // is constrained to appropriate LOD levels in order to prevent aliasing.
                // The environment map is first sampled without custom LOD selection to determine
                // the hardware-selected LOD, and this is then used to constrain the final LOD selection
                // so that excessive surface smoothness does not cause aliasing (e.g. on curved geometry
                // where the normal is varying rapidly).

                // Note: Shader Model 4.1 or higher can provide this directly via CalculateLevelOfDetail(), and
                // manual calculation via derivatives is also possible, but for simplicity we use the 
                // hardware LOD calculation with the alpha channel containing the LOD for each mipmap.
                float automaticRefractionLOD = UNPACK_LOD(sampleRefraction(refractionSampler, refractionCoords).a);
                float requestedRefractionLOD = max(automaticRefractionLOD, refractionLOD);
            #else
                float requestedRefractionLOD = refractionLOD;
            #endif

            #if !defined(SS_REFRACTIONMAP_3D) && !defined(ADOBE_TRANSPARENCY_G_BUFFER)
                // #if defined(ALPHABLEND)
                //     if (alpha <= 0.4) {
                //         requestedRefractionLOD = 0.0;
                //     }
                // #endif
                vec4 refraction_colour = sampleRefractionLod(refractionSampler, refractionCoords, requestedRefractionLOD);
                #if defined(SS_VOLUME_THICKNESS) && defined(SS_DEPTHINREFRACTIONALPHA)
                    // If the refracted texel is closer to the camera than the pixel being rendered, use the un-refracted texel instead.
                    if ((1.0 - refraction_colour.a) - sceneDepthNormalized < -0.005) {
                        refraction_colour = refraction_clear;
                    }
                    // thickness = (1.0 - refraction_clear.a) - sceneDepthNormalized;
                    thickness = max(thickness, 0.0);
                #endif
                #if defined(ALPHABLEND) || defined(SS_LINKALPHAWITHCLEARREFRACTION)
                    // Blend between clear, unrefracted background and the refracted one.
                    refraction_colour.rgb = mix(refraction_clear.rgb, refraction_colour.rgb, alpha);
                #endif

                environmentRefraction.rgb = refraction_colour.rgb;
            #else
                environmentRefraction = sampleRefractionLod(refractionSampler, refractionCoords, requestedRefractionLOD);
            #endif
        #else
            float lodRefractionNormalized = saturate(refractionLOD / log2(vRefractionMicrosurfaceInfos.x));
            float lodRefractionNormalizedDoubled = lodRefractionNormalized * 2.0;

            vec4 environmentRefractionMid = sampleRefraction(refractionSampler, refractionCoords);
            if(lodRefractionNormalizedDoubled < 1.0){
                environmentRefraction = mix(
                    sampleRefraction(refractionSamplerHigh, refractionCoords),
                    environmentRefractionMid,
                    lodRefractionNormalizedDoubled
                );
            }else{
                environmentRefraction = mix(
                    environmentRefractionMid,
                    sampleRefraction(refractionSamplerLow, refractionCoords),
                    lodRefractionNormalizedDoubled - 1.0
                );
            }
        #endif

        #ifdef SS_RGBDREFRACTION
            environmentRefraction.rgb = fromRGBD(environmentRefraction);
        #endif

        #ifdef SS_GAMMAREFRACTION
            environmentRefraction.rgb = toLinearSpace(environmentRefraction.rgb);
        #endif

        // _____________________________ Levels _____________________________________
        environmentRefraction.rgb *= vRefractionInfos.x;

    #endif

    // _____________________________ Reflection Info _______________________________________
    #ifdef REFLECTION
        vec4 environmentRadiance = vec4(0., 0., 0., 0.);
        vec3 environmentIrradiance = vec3(0., 0., 0.);

        #ifdef ANISOTROPIC
            vec3 reflectionVector = computeReflectionCoords(vec4(vPositionW, 1.0), anisotropicNormal);
        #else
            vec3 reflectionVector = computeReflectionCoords(vec4(vPositionW, 1.0), normalW);
        #endif

        #ifdef REFLECTIONMAP_OPPOSITEZ
            reflectionVector.z *= -1.0;
        #endif

        // _____________________________ 2D vs 3D Maps ________________________________
        #ifdef REFLECTIONMAP_3D
            vec3 reflectionCoords = reflectionVector;
        #else
            vec2 reflectionCoords = reflectionVector.xy;
            #ifdef REFLECTIONMAP_PROJECTION
                reflectionCoords /= reflectionVector.z;
            #endif
            reflectionCoords.y = 1.0 - reflectionCoords.y;
        #endif

        #if defined(LODINREFLECTIONALPHA) && !defined(REFLECTIONMAP_SKYBOX)
            float reflectionLOD = getLodFromAlphaG(vReflectionMicrosurfaceInfos.x, alphaG, NdotVUnclamped);
        #elif defined(LINEARSPECULARREFLECTION)
            float reflectionLOD = getLinearLodFromRoughness(vReflectionMicrosurfaceInfos.x, roughness);
        #else
            float reflectionLOD = getLodFromAlphaG(vReflectionMicrosurfaceInfos.x, alphaG);
        #endif

        #ifdef LODBASEDMICROSFURACE
            // Apply environment convolution scale/offset filter tuning parameters to the mipmap LOD selection
            reflectionLOD = reflectionLOD * vReflectionMicrosurfaceInfos.y + vReflectionMicrosurfaceInfos.z;

            #ifdef LODINREFLECTIONALPHA
                // Automatic LOD adjustment to ensure that the smoothness-based environment LOD selection
                // is constrained to appropriate LOD levels in order to prevent aliasing.
                // The environment map is first sampled without custom LOD selection to determine
                // the hardware-selected LOD, and this is then used to constrain the final LOD selection
                // so that excessive surface smoothness does not cause aliasing (e.g. on curved geometry
                // where the normal is varying rapidly).

                // Note: Shader Model 4.1 or higher can provide this directly via CalculateLevelOfDetail(), and
                // manual calculation via derivatives is also possible, but for simplicity we use the
                // hardware LOD calculation with the alpha channel containing the LOD for each mipmap.
                float automaticReflectionLOD = UNPACK_LOD(sampleReflection(reflectionSampler, reflectionCoords).a);
                float requestedReflectionLOD = max(automaticReflectionLOD, reflectionLOD);
            #else
                float requestedReflectionLOD = reflectionLOD;
            #endif

            environmentRadiance = sampleReflectionLod(reflectionSampler, reflectionCoords, requestedReflectionLOD);
        #else
            float lodReflectionNormalized = saturate(reflectionLOD / log2(vReflectionMicrosurfaceInfos.x));
            float lodReflectionNormalizedDoubled = lodReflectionNormalized * 2.0;

            vec4 environmentSpecularMid = sampleReflection(reflectionSampler, reflectionCoords);
            if(lodReflectionNormalizedDoubled < 1.0){
                environmentRadiance = mix(
                    sampleReflection(reflectionSamplerHigh, reflectionCoords),
                    environmentSpecularMid,
                    lodReflectionNormalizedDoubled
                );
            }else{
                environmentRadiance = mix(
                    environmentSpecularMid,
                    sampleReflection(reflectionSamplerLow, reflectionCoords),
                    lodReflectionNormalizedDoubled - 1.0
                );
            }
        #endif

        #ifdef RGBDREFLECTION
            environmentRadiance.rgb = fromRGBD(environmentRadiance);
        #endif

        #ifdef GAMMAREFLECTION
            environmentRadiance.rgb = toLinearSpace(environmentRadiance.rgb);
        #endif

        // _____________________________ Irradiance ________________________________
        #ifdef USESPHERICALFROMREFLECTIONMAP
            #if defined(NORMAL) && defined(USESPHERICALINVERTEX)
                environmentIrradiance = vEnvironmentIrradiance;
            #else
                #ifdef ANISOTROPIC
                    vec3 irradianceVector = vec3(reflectionMatrix * vec4(anisotropicNormal, 0)).xyz;
                #else
                    vec3 irradianceVector = vec3(reflectionMatrix * vec4(normalW, 0)).xyz;
                #endif

                #ifdef REFLECTIONMAP_OPPOSITEZ
                    irradianceVector.z *= -1.0;
                #endif

                environmentIrradiance = computeEnvironmentIrradiance(irradianceVector);
            #endif
        #elif defined(USEIRRADIANCEMAP)
            environmentIrradiance = sampleReflection(irradianceSampler, reflectionCoords).rgb;
            #ifdef RGBDREFLECTION
                environmentIrradiance.rgb = fromRGBD(environmentIrradiance);
            #endif

            #ifdef GAMMAREFLECTION
                environmentIrradiance.rgb = toLinearSpace(environmentIrradiance.rgb);
            #endif
        #endif

        // _____________________________ Levels _____________________________________
        environmentRadiance.rgb *= vReflectionInfos.x;
        environmentRadiance.rgb *= vReflectionColor.rgb;
        environmentIrradiance *= vReflectionColor.rgb;

        #ifdef SS_LINKALPHAWITHCLEARREFRACTION
            environmentRadiance.rgb *= alpha;
        #endif

    #endif

    // ___________________ Compute Reflectance aka R0 F0 info _________________________
    float reflectance = max(max(surfaceReflectivityColor.r, surfaceReflectivityColor.g), surfaceReflectivityColor.b);
    float reflectance90 = fresnelGrazingReflectance(reflectance);
    vec3 specularEnvironmentR0 = surfaceReflectivityColor.rgb;
    vec3 specularEnvironmentR90 = vec3(1.0, 1.0, 1.0) * reflectance90;

    // ________________________________ Sheen Information ______________________________
    #ifdef SHEEN
        float sheenIntensity = vSheenColor.a;

        #ifdef SHEEN_TEXTURE
            vec4 sheenMapData = texture2D(sheenSampler, vSheenUV + uvOffset) * vSheenInfos.y;
            sheenIntensity *= sheenMapData.a;
        #endif

        #ifdef SHEEN_LINKWITHALBEDO
            float sheenFactor = pow5(1.0-sheenIntensity);
            vec3 sheenColor = baseColor.rgb*(1.0-sheenFactor);
            float sheenRoughness = sheenIntensity;
            // remap albedo.
            surfaceAlbedo.rgb *= sheenFactor;
        #else
            vec3 sheenColor = vSheenColor.rgb;
            #ifdef SHEEN_TEXTURE
                sheenColor.rgb *= toLinearSpace(sheenMapData.rgb);
            #endif
            float sheenRoughness = roughness;

            // Sheen Lobe Layering.
            sheenIntensity *= (1. - reflectance);

            // Remap F0 and sheen.
            sheenColor *= sheenIntensity;
        #endif

        // Sheen Reflection
        #if defined(REFLECTION)
            float sheenAlphaG = convertRoughnessToAverageSlope(sheenRoughness);

            #ifdef SPECULARAA
                // Adapt linear roughness (alphaG) to geometric curvature of the current pixel.
                sheenAlphaG += AARoughnessFactors.y;
            #endif

            vec4 environmentSheenRadiance = vec4(0., 0., 0., 0.);

            // _____________________________ 2D vs 3D Maps ________________________________
            #if defined(LODINREFLECTIONALPHA) && !defined(REFLECTIONMAP_SKYBOX)
                float sheenReflectionLOD = getLodFromAlphaG(vReflectionMicrosurfaceInfos.x, sheenAlphaG, NdotVUnclamped);
            #elif defined(LINEARSPECULARREFLECTION)
                float sheenReflectionLOD = getLinearLodFromRoughness(vReflectionMicrosurfaceInfos.x, sheenRoughness);
            #else
                float sheenReflectionLOD = getLodFromAlphaG(vReflectionMicrosurfaceInfos.x, sheenAlphaG);
            #endif

            #ifdef LODBASEDMICROSFURACE
                // Apply environment convolution scale/offset filter tuning parameters to the mipmap LOD selection
                sheenReflectionLOD = sheenReflectionLOD * vReflectionMicrosurfaceInfos.y + vReflectionMicrosurfaceInfos.z;
                environmentSheenRadiance = sampleReflectionLod(reflectionSampler, reflectionCoords, sheenReflectionLOD);
            #else
                float lodSheenReflectionNormalized = saturate(sheenReflectionLOD / log2(vReflectionMicrosurfaceInfos.x));
                float lodSheenReflectionNormalizedDoubled = lodSheenReflectionNormalized * 2.0;

                vec4 environmentSheenMid = sampleReflection(reflectionSampler, reflectionCoords);
                if(lodSheenReflectionNormalizedDoubled < 1.0){
                    environmentSheenRadiance = mix(
                        sampleReflection(reflectionSamplerHigh, reflectionCoords),
                        environmentSheenMid,
                        lodSheenReflectionNormalizedDoubled
                    );
                }else{
                    environmentSheenRadiance = mix(
                        environmentSheenMid,
                        sampleReflection(reflectionSamplerLow, reflectionCoords),
                        lodSheenReflectionNormalizedDoubled - 1.0
                    );
                }
            #endif

            #ifdef RGBDREFLECTION
                environmentSheenRadiance.rgb = fromRGBD(environmentSheenRadiance);
            #endif

            #ifdef GAMMAREFLECTION
                environmentSheenRadiance.rgb = toLinearSpace(environmentSheenRadiance.rgb);
            #endif

            // _____________________________ Levels _____________________________________
            environmentSheenRadiance.rgb *= vReflectionInfos.x;
            environmentSheenRadiance.rgb *= vReflectionColor.rgb;

            #ifdef SS_LINKALPHAWITHCLEARREFRACTION
                environmentSheenRadiance.rgb *= alpha;
            #endif
        #endif
    #endif

    // _____________________________ Clear Coat Information ____________________________
    #ifdef CLEARCOAT
        // Clear COAT parameters.
        float clearCoatIntensity = vClearCoatParams.x;
        float clearCoatRoughness = vClearCoatParams.y;

        #ifdef CLEARCOAT_TEXTURE
            vec2 clearCoatMapData = texture2D(clearCoatSampler, vClearCoatUV + uvOffset).rg * vClearCoatInfos.y;
            clearCoatIntensity *= clearCoatMapData.x;
            clearCoatRoughness *= clearCoatMapData.y;
        #endif

        #ifdef CLEARCOAT_TINT
            vec3 clearCoatColor = vClearCoatTintParams.rgb;
            float clearCoatThickness = vClearCoatTintParams.a;

            #ifdef CLEARCOAT_TINT_TEXTURE
                vec4 clearCoatTintMapData = texture2D(clearCoatTintSampler, vClearCoatTintUV + uvOffset);
                clearCoatColor *= toLinearSpace(clearCoatTintMapData.rgb);
                clearCoatThickness *= clearCoatTintMapData.a;
            #endif

            clearCoatColor = computeColorAtDistanceInMedia(clearCoatColor, clearCoatColorAtDistance);
        #endif

        // remapping and linearization of clear coat roughness
        // Let s see how it ends up in gltf
        // clearCoatRoughness = mix(0.089, 0.6, clearCoatRoughness);

        // Remap F0 to account for the change of interface within the material.
        vec3 specularEnvironmentR0Updated = getR0RemappedForClearCoat(specularEnvironmentR0);
        specularEnvironmentR0 = mix(specularEnvironmentR0, specularEnvironmentR0Updated, clearCoatIntensity);

        #ifdef CLEARCOAT_BUMP
            #ifdef NORMALXYSCALE
                float clearCoatNormalScale = 1.0;
            #else
                float clearCoatNormalScale = vClearCoatBumpInfos.y;
            #endif

            #if defined(TANGENT) && defined(NORMAL)
                mat3 TBNClearCoat = vTBN;
            #else
                mat3 TBNClearCoat = cotangent_frame(clearCoatNormalW * clearCoatNormalScale, vPositionW, vClearCoatBumpUV, vClearCoatTangentSpaceParams);
            #endif

            #ifdef OBJECTSPACE_NORMALMAP
                clearCoatNormalW = normalize(texture2D(clearCoatBumpSampler, vClearCoatBumpUV + uvOffset).xyz  * 2.0 - 1.0);
                clearCoatNormalW = normalize(mat3(normalMatrix) * clearCoatNormalW);
            #else
                clearCoatNormalW = perturbNormal(TBNClearCoat, texture2D(clearCoatBumpSampler, vClearCoatBumpUV + uvOffset).xyz, vClearCoatBumpInfos.y);
            #endif
        #endif

        #if defined(FORCENORMALFORWARD) && defined(NORMAL)
            clearCoatNormalW *= sign(dot(clearCoatNormalW, faceNormal));
        #endif

        #if defined(TWOSIDEDLIGHTING) && defined(NORMAL)
            clearCoatNormalW = gl_FrontFacing ? clearCoatNormalW : -clearCoatNormalW;
        #endif

        // Clear Coat AA
        vec2 clearCoatAARoughnessFactors = getAARoughnessFactors(clearCoatNormalW.xyz);

        // Compute N dot V.
        float clearCoatNdotVUnclamped = dot(clearCoatNormalW, viewDirectionW);
        // The order 1886 page 3.
        float clearCoatNdotV = absEps(clearCoatNdotVUnclamped);

        #ifdef CLEARCOAT_TINT
            // Used later on in the light fragment and ibl.
            vec3 clearCoatVRefract = -refract(vPositionW, clearCoatNormalW, vClearCoatRefractionParams.y);
            // The order 1886 page 3.
            float clearCoatNdotVRefract = absEps(dot(clearCoatNormalW, clearCoatVRefract));
            vec3 absorption = vec3(0.);
        #endif

        // Clear Coat Reflection
        #if defined(REFLECTION)
            float clearCoatAlphaG = convertRoughnessToAverageSlope(clearCoatRoughness);

            #ifdef SPECULARAA
                // Adapt linear roughness (alphaG) to geometric curvature of the current pixel.
                clearCoatAlphaG += clearCoatAARoughnessFactors.y;
            #endif

            vec4 environmentClearCoatRadiance = vec4(0., 0., 0., 0.);

            vec3 clearCoatReflectionVector = computeReflectionCoords(vec4(vPositionW, 1.0), clearCoatNormalW);
            #ifdef REFLECTIONMAP_OPPOSITEZ
                clearCoatReflectionVector.z *= -1.0;
            #endif

            // _____________________________ 2D vs 3D Maps ________________________________
            #ifdef REFLECTIONMAP_3D
                vec3 clearCoatReflectionCoords = clearCoatReflectionVector;
            #else
                vec2 clearCoatReflectionCoords = clearCoatReflectionVector.xy;
                #ifdef REFLECTIONMAP_PROJECTION
                    clearCoatReflectionCoords /= clearCoatReflectionVector.z;
                #endif
                clearCoatReflectionCoords.y = 1.0 - clearCoatReflectionCoords.y;
            #endif

            #if defined(LODINREFLECTIONALPHA) && !defined(REFLECTIONMAP_SKYBOX)
                float clearCoatReflectionLOD = getLodFromAlphaG(vReflectionMicrosurfaceInfos.x, clearCoatAlphaG, clearCoatNdotVUnclamped);
            #elif defined(LINEARSPECULARREFLECTION)
                float sheenReflectionLOD = getLinearLodFromRoughness(vReflectionMicrosurfaceInfos.x, clearCoatRoughness);
            #else
                float clearCoatReflectionLOD = getLodFromAlphaG(vReflectionMicrosurfaceInfos.x, clearCoatAlphaG);
            #endif

            #ifdef LODBASEDMICROSFURACE
                // Apply environment convolution scale/offset filter tuning parameters to the mipmap LOD selection
                clearCoatReflectionLOD = clearCoatReflectionLOD * vReflectionMicrosurfaceInfos.y + vReflectionMicrosurfaceInfos.z;
                float requestedClearCoatReflectionLOD = clearCoatReflectionLOD;

                environmentClearCoatRadiance = sampleReflectionLod(reflectionSampler, clearCoatReflectionCoords, requestedClearCoatReflectionLOD);
            #else
                float lodClearCoatReflectionNormalized = saturate(clearCoatReflectionLOD / log2(vReflectionMicrosurfaceInfos.x));
                float lodClearCoatReflectionNormalizedDoubled = lodClearCoatReflectionNormalized * 2.0;

                vec4 environmentClearCoatMid = sampleReflection(reflectionSampler, reflectionCoords);
                if(lodClearCoatReflectionNormalizedDoubled < 1.0){
                    environmentClearCoatRadiance = mix(
                        sampleReflection(reflectionSamplerHigh, clearCoatReflectionCoords),
                        environmentClearCoatMid,
                        lodClearCoatReflectionNormalizedDoubled
                    );
                }else{
                    environmentClearCoatRadiance = mix(
                        environmentClearCoatMid,
                        sampleReflection(reflectionSamplerLow, clearCoatReflectionCoords),
                        lodClearCoatReflectionNormalizedDoubled - 1.0
                    );
                }
            #endif

            #ifdef RGBDREFLECTION
                environmentClearCoatRadiance.rgb = fromRGBD(environmentClearCoatRadiance);
            #endif

            #ifdef GAMMAREFLECTION
                environmentClearCoatRadiance.rgb = toLinearSpace(environmentClearCoatRadiance.rgb);
            #endif

            // _____________________________ Levels _____________________________________
            environmentClearCoatRadiance.rgb *= vReflectionInfos.x;
            environmentClearCoatRadiance.rgb *= vReflectionColor.rgb;

            #ifdef SS_LINKALPHAWITHCLEARREFRACTION
                environmentClearCoatRadiance.rgb *= alpha;
            #endif
        #endif
    #endif

    // _____________________________ IBL BRDF + Energy Cons ________________________________
    #if defined(ENVIRONMENTBRDF)
        // BRDF Lookup
        vec3 environmentBrdf = getBRDFLookup(NdotV, roughness);

        #ifdef MS_BRDF_ENERGY_CONSERVATION
            vec3 energyConservationFactor = getEnergyConservationFactor(specularEnvironmentR0, environmentBrdf);
        #endif
    #endif

    // ___________________________________ SubSurface ______________________________________
    #ifdef SUBSURFACE
        #ifdef SS_REFRACTION
            float refractionIntensity = vSubSurfaceIntensity.x;
        #endif
        #ifdef SS_TRANSLUCENCY
            float translucencyIntensity = vSubSurfaceIntensity.y;
        #endif
        #ifdef SS_SCATTERING
            float scatteringIntensity = vSubSurfaceIntensity.z;
        #endif

        #ifdef SS_THICKNESSANDMASK_TEXTURE
            vec4 thicknessMap = texture2D(thicknessSampler, vThicknessUV + uvOffset);

            // If the scene depth is in the refraction alpha then we already have an accurate thickness value.
            #if !defined(SS_DEPTHINREFRACTIONALPHA)
                thickness = thicknessMap.r * vThicknessParam.y + vThicknessParam.x;
            #endif

            #ifdef SS_MASK_FROM_THICKNESS_TEXTURE
                #ifdef SS_REFRACTION
                    refractionIntensity *= thicknessMap.g;
                #endif
                #ifdef SS_TRANSLUCENCY
                    translucencyIntensity *= thicknessMap.b;
                #endif
                #ifdef SS_SCATTERING
                    scatteringIntensity *= thicknessMap.a;
                #endif
            #elif defined(SS_MASK_FROM_THICKNESS_TEXTURE_GLTF)
                #ifdef SS_REFRACTION
                    refractionIntensity *= thicknessMap.r;
                #endif
                #ifdef SS_TRANSLUCENCY
                    translucencyIntensity *= thicknessMap.r;
                #endif
                #if !defined(SS_VOLUME_THICKNESS)
                    thickness = thicknessMap.g * vThicknessParam.y + vThicknessParam.x;
                #endif
            #endif
        #endif

        #ifdef SS_LINKALPHAWITHCLEARREFRACTION
            // If we're relying on a clear, non-coloured "refraction" where alpha is 0, we need to make sure
            // refractionIntensity is at least (1 - alpha).
            refractionIntensity = max(refractionIntensity, 1.0 - alpha);
        #endif
        
        #ifdef SS_TRANSLUCENCY
            thickness = maxEps(thickness);
            vec3 transmittance = transmittanceBRDF_Burley(vTintColor.rgb, vDiffusionDistance, thickness);
            transmittance *= translucencyIntensity;
        #endif
    #endif

    // ____________________________________________________________________________________
    // _____________________________ Direct Lighting Info __________________________________
    vec3 diffuseBase = vec3(0., 0., 0.);
    #ifdef SPECULARTERM
        vec3 specularBase = vec3(0., 0., 0.);
    #endif
    #ifdef CLEARCOAT
        vec3 clearCoatBase = vec3(0., 0., 0.);
    #endif
    #ifdef SHEEN
        vec3 sheenBase = vec3(0., 0., 0.);
    #endif

    #ifdef LIGHTMAP
        vec4 lightmapColor = texture2D(lightmapSampler, vLightmapUV + uvOffset);

        #ifdef RGBDLIGHTMAP
            lightmapColor.rgb = fromRGBD(lightmapColor);
        #endif

        #ifdef GAMMALIGHTMAP
            lightmapColor.rgb = toLinearSpace(lightmapColor.rgb);
        #endif
        lightmapColor.rgb *= vLightmapInfos.y;
    #endif

    // Direct Lighting Variables
    preLightingInfo preInfo;
    lightingInfo info;
    float shadow = 1.; // 1 - shadowLevel

    #include<lightFragment>[0..maxSimultaneousLights]

    // _________________________ Specular Environment Oclusion __________________________
    #if defined(ENVIRONMENTBRDF) && !defined(REFLECTIONMAP_SKYBOX)
        vec3 specularEnvironmentReflectance = getReflectanceFromBRDFLookup(specularEnvironmentR0, environmentBrdf);

        #ifdef RADIANCEOCCLUSION
            #ifdef AMBIENTINGRAYSCALE
                float ambientMonochrome = ambientOcclusionColor.r;
            #else
                float ambientMonochrome = getLuminance(ambientOcclusionColor);
            #endif

            float seo = environmentRadianceOcclusion(ambientMonochrome, NdotVUnclamped);
            specularEnvironmentReflectance *= seo;
        #endif

        #ifdef HORIZONOCCLUSION
            #ifdef BUMP
                #ifdef REFLECTIONMAP_3D
                    float eho = environmentHorizonOcclusion(-viewDirectionW, normalW);
                    specularEnvironmentReflectance *= eho;
                #endif
            #endif
        #endif
    #else
        // Jones implementation of a well balanced fast analytical solution.
        vec3 specularEnvironmentReflectance = getReflectanceFromAnalyticalBRDFLookup_Jones(NdotV, specularEnvironmentR0, specularEnvironmentR90, sqrt(microSurface));
    #endif

    // _____________________________ Sheen Environment Oclusion __________________________
    #if defined(SHEEN) && defined(REFLECTION)
        vec3 sheenEnvironmentReflectance = getSheenReflectanceFromBRDFLookup(sheenColor, environmentBrdf);

        #ifdef RADIANCEOCCLUSION
            sheenEnvironmentReflectance *= seo;
        #endif

        #ifdef HORIZONOCCLUSION
            #ifdef BUMP
                #ifdef REFLECTIONMAP_3D
                    sheenEnvironmentReflectance *= eho;
                #endif
            #endif
        #endif
    #endif

    // _________________________ Clear Coat Environment Oclusion __________________________
    #ifdef CLEARCOAT
        #if defined(ENVIRONMENTBRDF) && !defined(REFLECTIONMAP_SKYBOX)
            // BRDF Lookup
            vec3 environmentClearCoatBrdf = getBRDFLookup(clearCoatNdotV, clearCoatRoughness);
            vec3 clearCoatEnvironmentReflectance = getReflectanceFromBRDFLookup(vec3(vClearCoatRefractionParams.x), environmentClearCoatBrdf);

            #ifdef RADIANCEOCCLUSION
                float clearCoatSeo = environmentRadianceOcclusion(ambientMonochrome, clearCoatNdotVUnclamped);
                clearCoatEnvironmentReflectance *= clearCoatSeo;
            #endif

            #ifdef HORIZONOCCLUSION
                #ifdef BUMP
                    #ifdef REFLECTIONMAP_3D
                        float clearCoatEho = environmentHorizonOcclusion(-viewDirectionW, clearCoatNormalW);
                        clearCoatEnvironmentReflectance *= clearCoatEho;
                    #endif
                #endif
            #endif
        #else
            // Jones implementation of a well balanced fast analytical solution.
            vec3 clearCoatEnvironmentReflectance = getReflectanceFromAnalyticalBRDFLookup_Jones(clearCoatNdotV, vec3(1.), vec3(1.), sqrt(1. - clearCoatRoughness));
        #endif

        clearCoatEnvironmentReflectance *= clearCoatIntensity;

        #if defined(CLEARCOAT_TINT)
            // NdotL = NdotV in IBL
            absorption = computeClearCoatAbsorption(clearCoatNdotVRefract, clearCoatNdotVRefract, clearCoatColor, clearCoatThickness, clearCoatIntensity);

            #ifdef REFLECTION
                environmentIrradiance *= absorption;

                #ifdef SHEEN
                    sheenEnvironmentReflectance *= absorption;
                #endif
            #endif

            specularEnvironmentReflectance *= absorption;
        #endif

        // clear coat energy conservation
        float fresnelIBLClearCoat = fresnelSchlickGGX(clearCoatNdotV, vClearCoatRefractionParams.x, CLEARCOATREFLECTANCE90);
        fresnelIBLClearCoat *= clearCoatIntensity;

        float conservationFactor = (1. - fresnelIBLClearCoat);

        #ifdef REFLECTION
            environmentIrradiance *= conservationFactor;

            #ifdef SHEEN
                sheenEnvironmentReflectance *= conservationFactor;
            #endif
        #endif

        specularEnvironmentReflectance *= conservationFactor;
    #endif

    // _____________________________ Transmittance + Tint ________________________________
    #ifdef SS_REFRACTION
        vec3 refractionTransmittance = vec3(refractionIntensity);
        #ifdef SS_VOLUME_THICKNESS
            // Multiply thickness by camera range to get it back into world scale.
            // thickness = max(thickness * depthValues.y - depthValues.x, 0.0);
        #endif
        #ifdef SS_SCATTERING
            // vec3 scatteringColor = vec3(scatteringIntensity);
            // Based on Volumetric Light Scattering Eq 1
            // https://developer.nvidia.com/gpugems/GPUGems3/gpugems3_ch13.html
            vec3 inter = vec3(4.09712) + 4.20863 * vScatterColor - sqrt(vec3(9.59217) + 41.68086 * vScatterColor + vec3(17.7126) * vScatterColor * vScatterColor);
            // vec3 singleScatterAlbedo = vec3(0.68) * vScatterColor * vec3(scatteringIntensity);
            vec3 singleScatterAlbedo = (1.0 - inter * inter) / (1.0 - 0.5 * inter * inter);
            // vec3 singleScatterAlbedo = vec3(0.6);
            
        #endif

        #if defined(SS_THICKNESSANDMASK_TEXTURE) || defined(SS_VOLUME_THICKNESS)
            vec3 volumeAlbedo = computeColorAtDistanceInMedia(vTintColor.rgb, vTintColor.w);
            
            // // Simulate Flat Surface
            // thickness /=  dot(refractionVector, -normalW);

            // // Simulate Curved Surface
            // float NdotRefract = dot(normalW, refractionVector);
            // thickness *= -NdotRefract;
            #ifdef SS_SCATTERING
                vec3 scatterCoeff = singleScatterAlbedo * vRefractionInfos.y;
            #endif
            vec3 attenuation = cocaLambert(volumeAlbedo, thickness);
            refractionTransmittance *= attenuation;
        #elif defined(SS_LINKREFRACTIONTOTRANSPARENCY)
            // Tint the material with albedo.
            float maxChannel = max(max(surfaceAlbedo.r, surfaceAlbedo.g), surfaceAlbedo.b);
            vec3 volumeAlbedo = saturate(maxChannel * surfaceAlbedo);

            // Tint reflectance
            refractionTransmittance *= volumeAlbedo;
        #else
            // Compute tint from min distance only.
            vec3 volumeAlbedo = computeColorAtDistanceInMedia(vTintColor.rgb, vTintColor.w);
            #ifdef SS_SCATTERING
                vec3 scatterCoeff = singleScatterAlbedo * vRefractionInfos.y;
            #endif
            vec3 attenuation = cocaLambert(volumeAlbedo, vThicknessParam.y);
            refractionTransmittance *= attenuation;
        #endif

        #ifdef SS_SCATTERING
            vec3 scatterTransmittance = vec3(1.0) - attenuation;
            scatterTransmittance *= scatterCoeff;
            vec3 scattered_refraction_color = vec3(1.0);
            #ifdef SS_REFRACTIONMAP_3D
                // float scattered_alphaG = convertRoughnessToAverageSlope(1.0);
                float scattered_LOD = getLodFromAlphaG(vRefractionMicrosurfaceInfos.x, 1.0);
                scattered_refraction_color = sampleRefractionLod(refractionSampler, refractionCoords, scattered_LOD).rgb;
            #else
                float scattered_LOD = getLodFromAlphaG(vRefractionMicrosurfaceInfos.x, 0.75);
                scattered_refraction_color = sampleRefractionLod(refractionSampler, refractionCoords, scattered_LOD).rgb;
            #endif
            scatterTransmittance *= scattered_refraction_color; // this should be the scattered background light
            scatterTransmittance /= volumeAlbedo;
        #endif

        // Tint by the surface albedo
        #ifdef SS_ALBEDOFORREFRACTIONTINT
            refractionTransmittance *= surfaceAlbedo.rgb;
            #ifdef SS_SCATTERING
                scatterTransmittance *= surfaceAlbedo.rgb;
                refractionTransmittance *= pow(refractionTransmittance, vec3(5.0 * clamp(1.0 - vTintColor.w, 0.0, 1.0)));
            #endif
        #endif

        #ifdef SS_LINKALPHAWITHCLEARREFRACTION
            // Where alpha is 0, transmittance is 100% (i.e. we can see completely through the surface)
            refractionTransmittance = mix(vec3(1.0), refractionTransmittance, alpha);
            #ifdef SS_SCATTERING
                scatterTransmittance = mix(environmentRefraction.rgb, scatterTransmittance, alpha);
            #endif
        #endif

        // Decrease Albedo Contribution
        #ifndef ADOBE_TRANSPARENCY_G_BUFFER
            surfaceAlbedo *= (1. - refractionIntensity);
        #endif

        #ifdef REFLECTION
            // Decrease irradiance Contribution
            environmentIrradiance *= (1. - refractionIntensity);
        #endif

        // Add Multiple internal bounces.
        vec3 bounceSpecularEnvironmentReflectance = (2.0 * specularEnvironmentReflectance) / (1.0 + specularEnvironmentReflectance);
        specularEnvironmentReflectance = mix(bounceSpecularEnvironmentReflectance, specularEnvironmentReflectance, refractionIntensity);

        // In theory T = 1 - R.
        #ifdef SS_LINKALPHAWITHCLEARREFRACTION
            refractionTransmittance *= 1.0 - (specularEnvironmentReflectance * alpha);
            // Put alpha back to 1;
            // alpha = 1.0;
        #else
            refractionTransmittance *= 1.0 - specularEnvironmentReflectance;
        #endif
    #endif

    // _______________________________  IBL Translucency ________________________________
    #if defined(REFLECTION) && defined(SS_TRANSLUCENCY)
        #if defined(USESPHERICALINVERTEX)
            vec3 irradianceVector = vec3(reflectionMatrix * vec4(normalW, 0)).xyz;
            #ifdef REFLECTIONMAP_OPPOSITEZ
                irradianceVector.z *= -1.0;
            #endif
        #endif

        #if defined(USESPHERICALFROMREFLECTIONMAP)
            vec3 refractionIrradiance = computeEnvironmentIrradiance(-irradianceVector);
        #elif defined(USEIRRADIANCEMAP)
            vec3 refractionIrradiance = sampleReflection(irradianceSampler, -irradianceVector).rgb;
            #ifdef RGBDREFLECTION
                refractionIrradiance.rgb = fromRGBD(refractionIrradiance);
            #endif

            #ifdef GAMMAREFLECTION
                refractionIrradiance.rgb = toLinearSpace(refractionIrradiance.rgb);
            #endif
        #else
            vec3 refractionIrradiance = vec3(0.);
        #endif

        refractionIrradiance *= transmittance;
    #endif

    // ______________________________________________________________________________
    // _____________________________ Energy Conservation  ___________________________
    // Apply Energy Conservation.
    #ifndef METALLICWORKFLOW
        #ifdef SPECULAR_GLOSSINESS_ENERGY_CONSERVATION
            surfaceAlbedo.rgb = (1. - reflectance) * surfaceAlbedo.rgb;
        #endif
    #endif

    // _____________________________ Irradiance ______________________________________
    #ifdef REFLECTION
        vec3 finalIrradiance = environmentIrradiance;
        #if defined(SS_TRANSLUCENCY)
            finalIrradiance += refractionIrradiance;
        #endif
        finalIrradiance *= surfaceAlbedo.rgb;
    #endif

    // _____________________________ Specular ________________________________________
    #ifdef SPECULARTERM
        vec3 finalSpecular = specularBase;
        finalSpecular = max(finalSpecular, 0.0);

        // Full value needed for alpha.
        vec3 finalSpecularScaled = finalSpecular * vLightingIntensity.x * vLightingIntensity.w;
        #if defined(ENVIRONMENTBRDF) && defined(MS_BRDF_ENERGY_CONSERVATION)
            finalSpecularScaled *= energyConservationFactor;
        #endif
    #endif

    // _____________________________ Radiance ________________________________________
    #ifdef REFLECTION
        vec3 finalRadiance = environmentRadiance.rgb;
        finalRadiance *= specularEnvironmentReflectance;

        // Full value needed for alpha. 
        vec3 finalRadianceScaled = finalRadiance * vLightingIntensity.z;
        #if defined(ENVIRONMENTBRDF) && defined(MS_BRDF_ENERGY_CONSERVATION)
            finalRadianceScaled *= energyConservationFactor;
        #endif
    #endif

    // _____________________________ Refraction ______________________________________
    #ifdef SS_REFRACTION
        vec3 finalRefraction = environmentRefraction.rgb;
        finalRefraction *= refractionTransmittance;
        #ifdef SS_SCATTERING
            finalRefraction += clamp(scatterTransmittance, 0.0, 1.0);
            // refractionTransmittance += scatterTransmittance * environmentIrradiance;
            // refractionTransmittance = clamp(refractionTransmittance, 0.0, 1.0);
        #endif
    #endif

    // _____________________________ Clear Coat _______________________________________
    #ifdef CLEARCOAT
        vec3 finalClearCoat = clearCoatBase;
        finalClearCoat = max(finalClearCoat, 0.0);

        // Full value needed for alpha.
        vec3 finalClearCoatScaled = finalClearCoat * vLightingIntensity.x * vLightingIntensity.w;
        #if defined(ENVIRONMENTBRDF) && defined(MS_BRDF_ENERGY_CONSERVATION)
            finalClearCoatScaled *= energyConservationFactor;
        #endif

    // ____________________________ Clear Coat Radiance _______________________________
        #ifdef REFLECTION
            vec3 finalClearCoatRadiance = environmentClearCoatRadiance.rgb;
            finalClearCoatRadiance *= clearCoatEnvironmentReflectance;

            // Full value needed for alpha. 
            vec3 finalClearCoatRadianceScaled = finalClearCoatRadiance * vLightingIntensity.z;
        #endif

        #ifdef SS_REFRACTION
            finalRefraction *= conservationFactor;
            #ifdef CLEARCOAT_TINT
                finalRefraction *= absorption;
            #endif
        #endif
    #endif

    // ________________________________ Sheen ________________________________________
    #ifdef SHEEN
        vec3 finalSheen = sheenBase * sheenColor;
        finalSheen = max(finalSheen, 0.0);

        vec3 finalSheenScaled = finalSheen * vLightingIntensity.x * vLightingIntensity.w;
        // #if defined(ENVIRONMENTBRDF) && defined(MS_BRDF_ENERGY_CONSERVATION)
            // The sheen does not use the same BRDF so not energy conservation is possible
            // Should be less a problem as it is usually not metallic
            // finalSheenScaled *= energyConservationFactor;
        // #endif
        
        #ifdef REFLECTION
            vec3 finalSheenRadiance = environmentSheenRadiance.rgb;
            finalSheenRadiance *= sheenEnvironmentReflectance;

            // Full value needed for alpha. 
            vec3 finalSheenRadianceScaled = finalSheenRadiance * vLightingIntensity.z;
        #endif
    #endif

    // _____________________________ Highlights on Alpha _____________________________
    #ifdef ALPHABLEND
        float luminanceOverAlpha = 0.0;
        #if	defined(REFLECTION) && defined(RADIANCEOVERALPHA)
            luminanceOverAlpha += getLuminance(finalRadianceScaled);
            #if defined(CLEARCOAT)
                luminanceOverAlpha += getLuminance(finalClearCoatRadianceScaled);
            #endif
        #endif

        #if defined(SPECULARTERM) && defined(SPECULAROVERALPHA)
            luminanceOverAlpha += getLuminance(finalSpecularScaled);
        #endif

        #if defined(CLEARCOAT) && defined(CLEARCOATOVERALPHA)
            luminanceOverAlpha += getLuminance(finalClearCoatScaled);
        #endif

        #if defined(RADIANCEOVERALPHA) || defined(SPECULAROVERALPHA)
            alpha = saturate(alpha + luminanceOverAlpha * luminanceOverAlpha);
        #endif
    #endif
#endif

// _______________ Not done before as it is unlit only __________________________
// _____________________________ Diffuse ________________________________________
    vec3 finalDiffuse = diffuseBase;
    finalDiffuse *= surfaceAlbedo.rgb;
    finalDiffuse = max(finalDiffuse, 0.0);

// _____________________________ Ambient ________________________________________
    vec3 finalAmbient = vAmbientColor;
    finalAmbient *= surfaceAlbedo.rgb;

// _____________________________ Emissive ________________________________________
    vec3 finalEmissive = vEmissiveColor;
#ifdef EMISSIVE
    vec3 emissiveColorTex = texture2D(emissiveSampler, vEmissiveUV + uvOffset).rgb;
    finalEmissive *= toLinearSpace(emissiveColorTex.rgb);
    finalEmissive *=  vEmissiveInfos.y;
#endif

// ______________________________ Ambient ________________________________________
#ifdef AMBIENT
    vec3 ambientOcclusionForDirectDiffuse = mix(vec3(1.), ambientOcclusionColor, vAmbientInfos.w);
#else
    vec3 ambientOcclusionForDirectDiffuse = ambientOcclusionColor;
#endif

// _______________________________________________________________________________
// _____________________________ Composition _____________________________________
vec3 finalDiffuseLight = finalAmbient * ambientOcclusionColor + finalDiffuse	* ambientOcclusionForDirectDiffuse * vLightingIntensity.x;
vec3 finalReflectedLight = vec3(0.0);
vec3 finalRefractedLight = vec3(0.0);
vec3 finalEmissiveLight = finalEmissive	* vLightingIntensity.y;
#ifndef UNLIT
    #ifdef REFLECTION
        finalDiffuseLight += finalIrradiance	* ambientOcclusionColor * vLightingIntensity.z;
    #endif

    #ifdef SPECULARTERM
    // Computed in the previous step to help with alpha luminance.
    //	finalSpecular			* vLightingIntensity.x * vLightingIntensity.w +
        finalReflectedLight += finalSpecularScaled;
    #endif
    #ifdef CLEARCOAT
    // Computed in the previous step to help with alpha luminance.
    //	finalClearCoat			* vLightingIntensity.x * vLightingIntensity.w +
        finalReflectedLight += finalClearCoatScaled;
    #endif
    #ifdef SHEEN
    // Computed in the previous step to help with alpha luminance.
    //	finalSheen  			* vLightingIntensity.x * vLightingIntensity.w +
        finalReflectedLight += finalSheenScaled;
    #endif
    #ifdef REFLECTION
    // Comupted in the previous step to help with alpha luminance.
    //	finalRadiance			* vLightingIntensity.z +
        finalReflectedLight += finalRadianceScaled;
        #ifdef CLEARCOAT
        //  Comupted in the previous step to help with alpha luminance.
        //  finalClearCoatRadiance * vLightingIntensity.z 
            finalReflectedLight += finalClearCoatRadianceScaled;
        #endif
        #ifdef SHEEN
        //  Comupted in the previous step to help with alpha luminance.
        //  finalSheenRadiance * vLightingIntensity.z 
            finalReflectedLight += finalSheenRadianceScaled;
        #endif
    #endif
    #ifdef SS_REFRACTION
        finalRefractedLight += finalRefraction			* vLightingIntensity.z;
    #endif
#endif
        

#ifdef ADOBE_TRANSPARENCY_G_BUFFER

    #ifdef SS_REFRACTION
        finalDiffuseLight = mix(finalDiffuseLight, surfaceAlbedo, refractionIntensity);
    #endif
    gl_FragData[0] = applyImageProcessing(vec4(finalDiffuseLight, alpha));
    // gl_FragData[0] = vec4(vec3(1.0, 0.0, 0.0), 1.0);
    #ifndef UNLIT
        vec3 refref = vec3(0.0);
        #ifdef REFLECTION
            // If this is a thin surface, render reflection on both sides.
            // If it's a volume, render reflections only on front side.
            #ifndef SS_VOLUME_THICKNESS
                refref = finalReflectedLight;
            #else
                if (gl_FrontFacing) {
                    refref = finalReflectedLight;
                }
            #endif
        #endif
        #if defined(SS_REFRACTION) && defined(SS_VOLUME_THICKNESS)
            // If this is a volume, render refractions only on back sides.
            // TODO - maybe this isn't needed?
            if (!gl_FrontFacing) {
                // refref = finalRefractedLight;
            }
        #endif
        #if !defined(SS_DEPTHINREFRACTIONALPHA) && !defined(DEPTH_PEELING)
            float sceneDepthNormalized = 0.0;
        #endif
        gl_FragData[1] = applyImageProcessing(vec4(refref + finalEmissiveLight, 1.0 - sceneDepthNormalized));
        vec2 norm = (view * vec4(normalW, 1.0)).xy;
        norm = norm * 0.5 + 0.5;
        #ifndef SS_REFRACTION
            float refractionIntensity = 0.0;
        #elif defined(REFLECTION) && !defined(ADOBE_TRANSPARENCY_G_BUFFER)
            refractionIntensity -= specularEnvironmentReflectance.r;
        #endif
        gl_FragData[2] = vec4(refractionIntensity, roughness, norm.x, norm.y);
       
    #else
        gl_FragData[1] = vec4(1.0);
        gl_FragData[2] = vec4(1.0);
        gl_FragData[3] = vec4(1.0);
        gl_FragData[4] = vec4(1.0);
    #endif
    
    #ifdef ADOBE_TRANSPARENCY_G_BUFFER_VOLUME_INFO
        #ifdef SS_REFRACTION
            float ior = vRefractionInfos.y;
        #else
            float ior = 1.0;
        #endif
        ior /= 2.0;
        if (gl_FrontFacing) {
            ior += 0.5;
        }
        // if (ior > 0.5), it's front facing
        // and need to sub 0.5
        // ior *= 2.0 to get back to IOR.
        gl_FragData[3] = vec4(vTintColor.rgb, vTintColor.a);
        
        #ifdef SS_SCATTERING
            
            gl_FragData[4] = vec4(vScatterColor * vec3(scatteringIntensity), ior);
        #else
            
            gl_FragData[4] = vec4(vec3(1.0), ior);
        #endif
    #endif
#else
    // Reflection already includes the environment intensity.
    vec4 finalColor = vec4(finalDiffuseLight + finalReflectedLight + finalRefractedLight + finalEmissiveLight, alpha);
    #ifdef SS_LINKALPHAWITHCLEARREFRACTION
        finalColor = vec4(mix(finalRefractedLight, finalColor.rgb, alpha), 1.0);
    #endif

    // _____________________________ LightMappping _____________________________________
    #ifdef LIGHTMAP
        #ifndef LIGHTMAPEXCLUDED
            #ifdef USELIGHTMAPASSHADOWMAP
                finalColor.rgb *= lightmapColor;
            #else
                finalColor.rgb += lightmapColor;
            #endif
        #endif
    #endif

    #define CUSTOM_FRAGMENT_BEFORE_FOG

    // _____________________________ Finally ___________________________________________
        finalColor = max(finalColor, 0.0);
    #include<logDepthFragment>
    #include<fogFragment>(color, finalColor)

    #ifdef IMAGEPROCESSINGPOSTPROCESS
        // Sanitize output incase invalid normals or tangents have caused div by 0 or undefined behavior
        // this also limits the brightness which helpfully reduces over-sparkling in bloom (native handles this in the bloom blur shader)
        finalColor.rgb = clamp(finalColor.rgb, 0., 30.0);
    #else
        // Alway run to ensure we are going back to gamma space.
        finalColor = applyImageProcessing(finalColor);
    #endif

    // #if defined(SS_REFRACTION) && defined(ALPHABLEND) && defined(SS_DEPTHINREFRACTIONALPHA) && !defined(ADOBE_TRANSPARENCY_G_BUFFER)
    //     // Use refraction texture rather than actual alpha blending.
    //     finalColor.rgb = mix(sceneColor.rgb, finalColor.rgb, alpha);
    //     finalColor.a = 1.0;
    // #endif

        finalColor.a *= visibility;

    #ifdef PREMULTIPLYALPHA
        // Convert to associative (premultiplied) format if needed.
        finalColor.rgb *= finalColor.a;
    #endif

    #define CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR
    gl_FragColor = finalColor;

#endif // ADOBE_TRANSPARENCY_G_BUFFER
#include<pbrDebug>
}
