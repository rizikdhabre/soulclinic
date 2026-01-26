"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export default function ParticleSphere({
  size = 220, // 🔹 widget size (change freely)
}) {
  const mountRef = useRef(null);

  useEffect(() => {
    if (!mountRef.current) return;

    /* ================= SCENE ================= */
    const scene = new THREE.Scene();

    /* ================= CAMERA ================= */
    const camera = new THREE.PerspectiveCamera(
      65,
      mountRef.current.clientWidth / mountRef.current.clientHeight,
      0.1,
      100,
    );

    // 🔹 scaled-down camera distance
    camera.position.set(0, 0, 8.8);

    /* ================= RENDERER ================= */
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });

    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(
      mountRef.current.clientWidth,
      mountRef.current.clientHeight,
    );

    mountRef.current.appendChild(renderer.domElement);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    renderer.domElement.style.borderRadius = "9999px";

    /* ================= CONTROLS ================= */
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableZoom = false;
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.6;
    controls.update();

    /* ================= SHADERS ================= */
    const vertexShader = `
      attribute float size;
      varying vec3 vColor;
      uniform float time;

      void main() {
        vColor = color;

        vec3 pos = position;
        pos += normalize(position) * sin(time + length(position)) * 0.02;

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_PointSize = size * (240.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `;

    const fragmentShader = `
      varying vec3 vColor;

      void main() {
        vec2 uv = gl_PointCoord * 2.0 - 1.0;
        float r = dot(uv, uv);
        if (r > 1.0) discard;
        vec3 color = mix(
          vec3(dot(vColor, vec3(0.299, 0.587, 0.114))), // grayscale
          vColor,
          0.85 // keep 85% color
        );

        float glow = exp(-r * 2.8);
        float intensity = 0.85;
        gl_FragColor = vec4(color * glow * intensity, glow * 0.9);
      }
    `;

    /* ================= MATERIALS ================= */
    const coreMaterial = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 } },
      vertexShader,
      fragmentShader,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const ringMaterial = coreMaterial.clone();

    /* ================= CORE SPHERE ================= */
    const sphereGeo = new THREE.BufferGeometry();
    const spherePos = [];
    const sphereCol = [];
    const sphereSize = [];

    const palette = [
      new THREE.Color("#ff3fa4"),
      new THREE.Color("#00e5ff"),
      new THREE.Color("#4d7cff"),
      new THREE.Color("#ffe66d"),
      new THREE.Color("#9d4edd"),
    ];

    const sphereRadius = 3.0;
    const sphereCount = 18000;

    for (let i = 0; i < sphereCount; i++) {
      const phi = Math.acos(1 - (2 * i) / sphereCount);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;

      const x = sphereRadius * Math.sin(phi) * Math.cos(theta);
      const y = sphereRadius * Math.sin(phi) * Math.sin(theta);
      const z = sphereRadius * Math.cos(phi);

      spherePos.push(x, y, z);

      const c = palette[i % palette.length];
      sphereCol.push(c.r, c.g, c.b);

      sphereSize.push(Math.random() * 0.12 + 0.05);
    }

    sphereGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(spherePos, 3),
    );
    sphereGeo.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(sphereCol, 3),
    );
    sphereGeo.setAttribute(
      "size",
      new THREE.Float32BufferAttribute(sphereSize, 1),
    );

    const sphere = new THREE.Points(sphereGeo, coreMaterial);
    scene.add(sphere);

    /* ================= ORBIT RINGS ================= */
    const rings = new THREE.Group();
    const ringCount = 5;
    const ringRadius = 5.2;
    const ringParticles = 4800;

    for (let i = 0; i < ringCount; i++) {
      const geo = new THREE.BufferGeometry();
      const pos = [];
      const col = [];
      const sizeArr = [];

      const color = new THREE.Color().setHSL(0.55 + i * 0.12, 1, 0.6);

      for (let j = 0; j < ringParticles; j++) {
        const a = (j / ringParticles) * Math.PI * 2;

        pos.push(
          Math.cos(a) * ringRadius,
          (Math.random() - 0.5) * 0.12,
          Math.sin(a) * ringRadius,
        );

        col.push(color.r, color.g, color.b);
        sizeArr.push(Math.random() * 0.1 + 0.04);
      }

      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      geo.setAttribute("size", new THREE.Float32BufferAttribute(sizeArr, 1));

      const ring = new THREE.Points(geo, ringMaterial);
      ring.rotation.x = Math.random() * Math.PI;
      ring.rotation.y = Math.random() * Math.PI;
      rings.add(ring);
    }

    scene.add(rings);

    let isActive = true;

    const handleVisibility = () => {
      isActive = !document.hidden;
    };

    document.addEventListener("visibilitychange", handleVisibility);

    /* ================= ANIMATION ================= */
    let time = 0;
    let rafId;

    const animate = () => {
      rafId = requestAnimationFrame(animate);

      if (!isActive) return;

      time += 0.012;
      coreMaterial.uniforms.time.value = time;
      ringMaterial.uniforms.time.value = time;

      sphere.rotation.y += 0.0014;

      rings.children.forEach((r, i) => {
        const speed = 0.0014 + i * 0.0005;
        r.rotation.z += speed;
        r.rotation.x += speed * 0.6;
      });

      controls.update();
      renderer.render(scene, camera);
    };

    animate();

    /* ================= RESIZE ================= */
    const onResize = () => {
      if (!mountRef.current) return;
      const w = mountRef.current.clientWidth;
      const h = mountRef.current.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };

    window.addEventListener("resize", onResize);

    /* ================= CLEANUP ================= */
    return () => {
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(rafId);
      sphereGeo.dispose();
      coreMaterial.dispose();
      renderer.setAnimationLoop(null);

      renderer.dispose();
      controls.dispose();
      mountRef.current?.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div
      ref={mountRef}
      style={{ width: size, height: size }}
      className="rounded-full overflow-hidden"
    />
  );
}
