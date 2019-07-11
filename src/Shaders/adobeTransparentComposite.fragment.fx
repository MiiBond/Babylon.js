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
uniform float renderSize;
uniform sampler2D colourTexture;
uniform sampler2D reflectionTexture;
uniform sampler2D miscTexture;
#ifdef VOLUME_RENDERING
    uniform sampler2D interiorColorTexture;
    uniform sampler2D interiorInfoTexture;
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
    
    #ifdef LODBASEDMICROSFURACE
        float refractionLOD = getLodFromAlphaG(renderSize, 0.25 * misc.g * misc.g);
    #else
        float refractionLOD = 0.0;
    #endif
    vec4 reflection = texture2D(reflectionTexture, vUV);
    float pixel_depth = reflection.a;

    float front_facing = 0.0;
    #ifdef BACKGROUND_DEPTH
        float background_depth_no_refract = 1.0 - texture2D(backgroundDepth, vUV).r;
    #else
        float background_depth_no_refract = texture2D(textureSampler, vUV).a;
    #endif
    #ifdef VOLUME_RENDERING
        
        vec4 interiorColor = texture2D(interiorColorTexture, vUV);
        vec4 interiorInfo = texture2D(interiorInfoTexture, vUV);

        float thickness = 0.0;
        float refract_amount = 0.0;
        vec2 refractionCoords = vUV;
        vec2 norm = misc.ba * 2.0 - 1.0;
        front_facing = interiorInfo.b;
        if (front_facing == 1.0) {
            float ior_inverse = max(1.0 - interiorInfo.g, 0.0);
            thickness = max(pixel_depth - background_depth_no_refract, 0.0);
            float thickness_scale_for_refraction = min(20.0 * thickness, 0.5);
            // Use thickness, normal and ior to come up with new refraction coords.
            refractionCoords -= norm * 2.0 * REFRACTION_SCALE * thickness_scale_for_refraction * ior_inverse * ior_inverse;
        }
        
        #ifdef BACKGROUND_DEPTH
            float refracted_background_depth = 1.0 - texture2D(backgroundDepth, refractionCoords).r;
        #else
            float refracted_background_depth = texture2D(textureSampler, refractionCoords).a;
        #endif
        
        // Do refraction of light
        if (refracted_background_depth > pixel_depth) {
            refractionCoords = vUV;
        }
    
        vec4 background_refracted = sampleRefractionLod(textureSampler, refractionCoords, refractionLOD);
        vec4 background_clear = sampleRefractionLod(textureSampler, vUV, refractionLOD);
        if (front_facing == 0.0) {
            float norm_length = length(norm);
            float refracted_light_amount = min(norm_length * norm_length + misc.g, 1.0);
            background_refracted.rgb += reflection.rgb * refracted_light_amount;
        }

        

        vec3 refraction_color = mix(background_clear.rgb, background_refracted.rgb * colour.rgb, colour.a);
        
        // Interior calculation
        if (front_facing == 1.0) {
            vec3 clamped_color = clamp(interiorColor.rgb, vec3(0.000303527, 0.000303527, 0.000303527), vec3(0.991102, 0.991102, 0.991102));
            float density = interiorInfo.r;
            vec3 absorption_coeff = -log((clamped_color));
            vec3 scattering_coeff = vec3(0.6931472);
            float thickness_scale_for_absorption = 4000.0 * thickness;
            refraction_color *= 1.0 / exp((absorption_coeff + scattering_coeff) * TRANSPARENCY_SCENE_SCALE * density * thickness_scale_for_absorption);
            refraction_color = clamp(refraction_color.rgb, 0.0, 1.0);
        }
        vec3 finalColour = mix(colour.xyz, refraction_color, misc.r);
        
    #else
        vec4 background = sampleRefractionLod(textureSampler, vUV, refractionLOD);
        vec4 background_clear = texture2D(textureSampler, vUV);
        vec3 finalColour = mix(colour.xyz, background.xyz * colour.xyz, misc.r);
    #endif
    
    pixel_depth = max(pixel_depth, background_depth_no_refract);
    
    if (front_facing == 1.0) {
        finalColour += reflection.xyz;
    }
    finalColour = mix(background_clear.xyz, finalColour.xyz, colour.a);
    gl_FragColor = vec4(finalColour, pixel_depth);
}