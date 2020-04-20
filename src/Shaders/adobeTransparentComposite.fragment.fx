precision highp float;

// Samplers
varying vec2 vUV;
uniform sampler2D textureSampler;

#define SUBSURFACE
#define SS_REFRACTION
#ifdef LODBASEDMICROSFURACE
#extension GL_EXT_shader_texture_lod : enable
#endif
#include<pbrFragmentSamplersDeclaration>
#include<helperFunctions>
#include<pbrHelperFunctions>
#include<pbrBRDFFunctions>
#include<pbrIBLFunctions>
// Uniforms
// uniform mat4 world;
// uniform mat4 worldViewProjection;
// uniform sampler2D backgroundTexture;
uniform vec2 depthValues;
uniform float renderSize;
uniform float renderOpacity;
uniform sampler2D colourTexture;
uniform sampler2D reflectionTexture;
uniform sampler2D miscTexture;
#ifdef VOLUME_RENDERING
    uniform sampler2D attenuationTexture;
    uniform sampler2D scatterTexture;
#endif
#ifdef BACKGROUND_DEPTH
uniform sampler2D backgroundDepth;
#endif

#ifndef TRANSPARENCY_SCENE_SCALE
    #define TRANSPARENCY_SCENE_SCALE 1.0
#endif

void main(void) {
    
    vec4 misc = texture2D(miscTexture, vUV);
    vec4 colour = texture2D(colourTexture, vUV);
    vec4 background_clear = texture2D(textureSampler, vUV);
    
    #ifdef LODBASEDMICROSFURACE
        float refractionLOD = getLodFromAlphaG(renderSize, 0.25 * misc.g * misc.g);
    #else
        float refractionLOD = 0.0;
    #endif
    vec4 reflection = texture2D(reflectionTexture, vUV);
    float pixel_depth = reflection.a;

    reflection.rgb = toLinearSpace(reflection.rgb);
    colour.rgb = toLinearSpace(colour.rgb);
    background_clear.rgb = toLinearSpace(background_clear.rgb);
    
    float front_facing = 0.0;
    #ifdef BACKGROUND_DEPTH
        float background_depth_no_refract = 1.0 - texture2D(backgroundDepth, vUV).r;
    #else
        float background_depth_no_refract = background_clear.a;
    #endif
    #if defined(VOLUME_RENDERING) && !defined(BACKGROUND_DEPTH)
        
        vec4 attenuationColor = texture2D(attenuationTexture, vUV);
        vec4 scatterColor = texture2D(scatterTexture, vUV);

        float thickness = 0.0;
        float refract_amount = 0.0;
        vec2 refractionCoords = vUV;
        // vec2 norm = (misc.ba - vec2(0.5)) * 2.0;
        // vec3 normal_VS = vec3(norm.x, norm.y, 0.0);
        // normal_VS.z = sqrt(1.0 - dot(norm, norm));

        // Unpack IOR and front-facing value (which are stored together)
        float ior = scatterColor.a;
        if (ior > 0.502) {
            front_facing = 1.0;
            ior -= 0.5;
        }
        ior *= 2.0;
        if (front_facing == 1.0) {
            float ior_inverse = max(1.0 - ior, 0.0);
            float pixel_depth_world = (pixel_depth + 0.00001) * depthValues.y - depthValues.x;
            float background_depth_no_refract_world = (background_depth_no_refract + 0.00001) * depthValues.y - depthValues.x;
            thickness = max(pixel_depth_world - background_depth_no_refract_world, 0.0);
            // Multiply thickness by camera range to get it back into world scale.
            // Temp clamp this to 1.0 to avoid washed-out colour for front faces with scattering over background.
            // Remove this clamp when we fix the calculation.
            // thickness = max(thickness * depthValues.y - depthValues.x, 0.0);
            // Can't just modify the UV like this. Need to know screen aspect ratio.
            // refractionCoords -= norm * 0.005 * REFRACTION_SCALE * ior_inverse;
            refractionLOD *= ior_inverse;
        }
        
        // #ifdef BACKGROUND_DEPTH
        //     float refracted_background_depth = 1.0 - texture2D(backgroundDepth, refractionCoords).r;
        // #else
        //     float refracted_background_depth = texture2D(textureSampler, refractionCoords).a;
        // #endif
        
        // // Do refraction of light
        // if (refracted_background_depth > pixel_depth) {
        //     refractionCoords = vUV;
        // }
    
        // vec4 background_refracted = sampleRefractionLod(textureSampler, refractionCoords, refractionLOD);
        vec4 background_refracted = sampleRefractionLod(textureSampler, refractionCoords, refractionLOD);
        // if (front_facing == 0.0) {
        //     float norm_length = length(norm);
        //     float refracted_light_amount = min((norm_length * norm_length + 0.25) * misc.g, 1.0);
        //     background_refracted.rgb += reflection.rgb * refracted_light_amount;
        // }

        // vec3 refraction_color = mix(background_clear.rgb, background_refracted.rgb * colour.rgb, colour.a);
        // vec3 refraction_color = background_refracted.rgb;
        vec3 refraction_color = toLinearSpace(background_refracted.rgb);
        
        // Interior calculation
        if (front_facing == 1.0) {
            vec3 inter = vec3(4.09712)+4.20863*scatterColor.rgb-sqrt(vec3(9.59217)+41.68086*scatterColor.rgb+vec3(17.7126)*scatterColor.rgb*scatterColor.rgb);
            vec3 singleScatterAlbedo = (1.0-inter*inter)/(1.0-0.5*inter*inter);
            vec3 scatterCoeff = singleScatterAlbedo * ior;
            vec3 extinctionCoeff = computeColorAtDistanceInMedia(attenuationColor.rgb, attenuationColor.w);
            vec3 attenuation = cocaLambert(extinctionCoeff, thickness);
            // attenuation = attenuation * pow(scatterColor.rgb, vec3(scatterColor.rgb * 5.0));
            // refraction_color *= attenuation * pow(scatterColor.rgb, vec3(scatterColor.rgb * 5.0));
            refraction_color *= pow(attenuation, vec3(5.0 * clamp(1.0 - attenuationColor.w, 0.0, 1.0)));

            vec3 scatterTransmittance = vec3(1.0) - attenuation;
            scatterTransmittance *= scatterCoeff;
            scatterTransmittance /= extinctionCoeff;
            

            refraction_color += clamp(scatterTransmittance, 0.0, 1.0);
            
            // // Based on Volumetric Light Scattering Eq 1
            // // https://developer.nvidia.com/gpugems/GPUGems3/gpugems3_ch13.html
            // refraction_color *= 1.0 / exp((absorption_coeff) * density * thickness_scale * TRANSPARENCY_SCENE_SCALE);
            // refraction_color += colour.rgb * clamped_color * clamped_color * scattering_coeff * (1.0 - 1.0 / exp((scattering_coeff) * density * 0.1 * thickness_scale * TRANSPARENCY_SCENE_SCALE));
        }
        vec3 finalColour = mix(colour.xyz, refraction_color * colour.xyz, misc.r);
        
    #else
        vec4 background = sampleRefractionLod(textureSampler, vUV, refractionLOD);
        background.rgb = toLinearSpace(background.rgb);
        vec3 finalColour = mix(colour.xyz, background.xyz * colour.xyz, misc.r);
    #endif
    
    pixel_depth = max(pixel_depth, background_depth_no_refract);
    
    // If the object is solid, only add reflections for front (outside faces).
    #ifdef VOLUME_RENDERING
        if (front_facing == 1.0) {
            finalColour += reflection.xyz;
        }
    // If the object is hollow (thin surface), add the reflection for both front and back faces.
    #else
        finalColour += reflection.xyz;
    #endif
    finalColour = mix(background_clear.xyz, finalColour.xyz, colour.a * renderOpacity);
    gl_FragColor = vec4(toGammaSpace(finalColour), pixel_depth);
}