precision highp float;

// Attributes
attribute vec2 position;

const vec2 madd = vec2(0.5, 0.5);

void main(void) {
	gl_Position = vec4(position, 0.0, 1.0);
}