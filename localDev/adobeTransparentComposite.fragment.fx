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
uniform sampler2D emissiveTexture;
uniform sampler2D interiorTexture;
#ifdef BACKGROUND_DEPTH
uniform sampler2D backgroundDepth;
#endif

// Varying
// varying vec3 vPositionW;
// varying vec3 vNormalW;
// varying vec2 vUv;

void main(void) {
    
    vec4 misc = texture2D(miscTexture, vUV);
    vec4 colour = texture2D(colourTexture, vUV);
    
    #ifdef BACKGROUND_DEPTH
        float background_depth_no_refract = 1.0 - texture2D(backgroundDepth, vUV).r;
    #else
        float background_depth_no_refract = texture2D(textureSampler, vUV).a;
    #endif
    float refractionLOD = getLodFromAlphaG(renderSize, misc.g * misc.g * misc.g);
    vec4 reflection = texture2D(reflectionTexture, vUV);
    vec4 emissive = texture2D(emissiveTexture, vUV);
    vec4 interior = texture2D(interiorTexture, vUV);

    // If we're front-facing, get the depth.
    float pixel_depth = reflection.a;
    float thickness = 0.0;
    float thickness_scale = -1.0;
    if (emissive.a == 1.0) {
        thickness = max(pixel_depth - background_depth_no_refract, 0.0);
        thickness_scale = 200.0 * thickness;
    }
    
    vec3 depth_debug = vec3(1.0, 0.0, 0.0);
    // Use thickness, normal and ior to come up with new refraction coords.
    vec2 norm = misc.ba * 2.0 - 1.0;
    vec2 refractionCoords = vUV - norm * thickness * 5.0;
    #ifdef BACKGROUND_DEPTH
        float refracted_background_depth = 1.0 - texture2D(backgroundDepth, refractionCoords).r;
    #else
        float refracted_background_depth = texture2D(textureSampler, refractionCoords).a;
    #endif
    
    if (refracted_background_depth > pixel_depth) {
        refractionCoords = vUV;
    }
    vec4 background = sampleRefractionLod(textureSampler, refractionCoords, refractionLOD);

    pixel_depth = max(pixel_depth, background_depth_no_refract);
    
    // Interior calculation
    vec3 clamped_color = clamp(interior.rgb, vec3(0.000303527, 0.000303527, 0.000303527), vec3(0.991102, 0.991102, 0.991102));
    float density = interior.a;
    float scene_scale = 40.0;
    vec3 absorption_coeff = min(clamped_color*density*scene_scale, vec3(1.0)); 
    vec3 adsorption = pow(absorption_coeff, vec3(1.0 + thickness_scale));
    vec3 scattering_coeff = density*scene_scale*vec3(0.6931472);
    
    vec3 finalColour = mix(colour.xyz, background.xyz * colour.xyz * adsorption, misc.r);
    
    
    finalColour += reflection.xyz;
    finalColour = mix(background.xyz, finalColour.xyz, colour.a);
    gl_FragColor = vec4(finalColour, pixel_depth);
}