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

void main(void)
{
#ifdef ALPHATEST
	if (texture2D(diffuseSampler, vUV).a < 0.4)
		discard;
#endif
#ifdef DEPTHPEEL
	vec2 screenCoords = vec2(gl_FragCoord.x / depthPeelInfos.x, gl_FragCoord.y / depthPeelInfos.y);
	float depth = texture2D(depthSampler, screenCoords).r;
	// depth = (depthValues.x + (depthValues.y - depthValues.x) * depth);
	if (vDepthMetric <= depth) {
		discard;
	}
#endif

	gl_FragColor = vec4(vDepthMetric, vDepthMetric * vDepthMetric, 0.0, 1.0);
}