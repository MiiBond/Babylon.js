precision highp float;

// Samplers
varying vec2 vUV;
uniform sampler2D textureSampler;

#define SUBSURFACE
#define SS_REFRACTION
#define LODBASEDMICROSFURACE

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
uniform sampler2D interiorColorTexture;
uniform sampler2D interiorInfoTexture;
#ifdef BACKGROUND_DEPTH
uniform sampler2D backgroundDepth;
#endif

void main(void) {
    
    vec4 misc = texture2D(miscTexture, vUV);
    vec4 colour = texture2D(colourTexture, vUV);
    
    float refractionLOD = getLodFromAlphaG(renderSize, misc.g * misc.g * misc.g);
    vec4 reflection = texture2D(reflectionTexture, vUV);
    float pixel_depth = reflection.a;

    #ifdef VOLUME_RENDERING
        #ifdef BACKGROUND_DEPTH
            float background_depth_no_refract = 1.0 - texture2D(backgroundDepth, vUV).r;
        #else
            float background_depth_no_refract = texture2D(textureSampler, vUV).a;
        #endif
        vec4 interiorColor = texture2D(interiorColorTexture, vUV);
        vec4 interiorInfo = texture2D(interiorInfoTexture, vUV);

        float thickness = 0.0;
        float thickness_scale = -1.0;
        float refract_amount = 0.0;
        vec2 refractionCoords = vUV;
        // If we're front-facing
        if (interiorInfo.b == 1.0) {
            float ior_inverse = max(1.0 - interiorInfo.g, 0.0);
            thickness = max(pixel_depth - background_depth_no_refract, 0.0);
            thickness_scale = 20.0 * thickness;
            // Use thickness, normal and ior to come up with new refraction coords.
            vec2 norm = misc.ba * 2.0 - 1.0;
            // refractionCoords -= norm * 0.1 * ior_inverse * ior_inverse;
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
    
        vec4 background = sampleRefractionLod(textureSampler, refractionCoords, refractionLOD);

        pixel_depth = max(pixel_depth, background_depth_no_refract);
        
        // Interior calculation
        vec3 clamped_color = clamp(interiorColor.rgb, vec3(0.000303527, 0.000303527, 0.000303527), vec3(0.991102, 0.991102, 0.991102));
        float density = interiorInfo.r;
        float scene_scale = 40.0;
        vec3 absorption_coeff = min(clamped_color*density*scene_scale, vec3(1.0)); 
        vec3 adsorption = pow(absorption_coeff, vec3(1.0 + thickness_scale));
        vec3 scattering_coeff = density*scene_scale*vec3(0.6931472);
    
        vec3 finalColour = mix(colour.xyz, background.xyz * colour.xyz * adsorption, misc.r);
    #else
        vec4 background = sampleRefractionLod(textureSampler, vUV, refractionLOD);
        vec3 finalColour = mix(colour.xyz, background.xyz * colour.xyz, misc.r);
    #endif
    
    
    finalColour += reflection.xyz;
    finalColour = mix(background.xyz, finalColour.xyz, colour.a);
    gl_FragColor = vec4(finalColour, pixel_depth);
}