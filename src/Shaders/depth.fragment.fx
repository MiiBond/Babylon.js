#ifdef ALPHATEST
varying vec2 vUV;
uniform sampler2D diffuseSampler;
#endif

#ifdef DEPTHPEEL
uniform sampler2D depthSampler;
uniform vec2 depthValues;
uniform vec2 depthPeelInfos;
#endif

varying float vDepthMetric;

#ifdef PACKED
	#include<packingFunctions>
#endif

void main(void)
{
#ifdef ALPHATEST
	if (texture2D(diffuseSampler, vUV).a < 0.4)
		discard;
#endif
#ifdef DEPTHPEEL
	vec2 screenCoords = vec2(gl_FragCoord.x / depthPeelInfos.x, gl_FragCoord.y / depthPeelInfos.y);
	float depth = texture2D(depthSampler, screenCoords).r;
	#ifdef NONLINEARDEPTH
		if (gl_FragCoord.z <= depth) {
			discard;
		}
	#else
		if (vDepthMetric <= depth) {
			discard;
		}
	#endif
#endif

#ifdef NONLINEARDEPTH
	#ifdef PACKED
		gl_FragColor = pack(gl_FragCoord.z);
	#else
		gl_FragColor = vec4(gl_FragCoord.z, 0.0, 0.0, 0.0);
	#endif
#else
	#ifdef PACKED
		gl_FragColor = pack(vDepthMetric);
	#else
		gl_FragColor = vec4(vDepthMetric, 0.0, 0.0, 1.0);
	#endif
#endif
}