"use client";

import { useEffect, useRef } from "react";

export default function NeonLoader({ width = 160, height = 44 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl");
    if (!gl) return;

    const vertexShaderSource = `
      attribute vec2 position;
      void main() {
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `;

    const fragmentShaderSource = `
      precision highp float;
      uniform vec2 r;
      uniform float t;

      void main() {
        vec2 FC = gl_FragCoord.xy;
        vec2 p = (FC * 2.0 - r) / r.y;

        float a = atan(p.y, p.x);
        float l = length(p);
        vec3 c = vec3(0.0);

        for (float i = 0.0; i < 15.0; i++) {
          float m = sin(a * 10.0 + t * (2.0 + i * 0.5) - l * 20.0) * 0.05;
          c += vec3(2.0, i * 0.1, 1.0)
            * 0.0008
            / abs(l - 0.5 - m + i * 0.015);
        }

        gl_FragColor = vec4(c, 1.0);
      }
    `;

    function createShader(type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    }

    function createProgram(vsSrc, fsSrc) {
      const vs = createShader(gl.VERTEX_SHADER, vsSrc);
      const fs = createShader(gl.FRAGMENT_SHADER, fsSrc);
      const program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      return program;
    }

    const program = createProgram(vertexShaderSource, fragmentShaderSource);
    gl.useProgram(program);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1,  1, -1, -1, 1,
         1, -1,  1,  1, -1, 1
      ]),
      gl.STATIC_DRAW
    );

    const positionLoc = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

    const resolutionLoc = gl.getUniformLocation(program, "r");
    const timeLoc = gl.getUniformLocation(program, "t");

    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);

    const start = performance.now();
    let rafId;

    function render() {
      const time = (performance.now() - start) * 0.001;
      gl.uniform2f(resolutionLoc, width, height);
      gl.uniform1f(timeLoc, time);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      rafId = requestAnimationFrame(render);
    }

    render();

    return () => cancelAnimationFrame(rafId);
  }, [width, height]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className="block rounded-full"
    />
  );
}
