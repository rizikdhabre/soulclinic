"use client";

import { useGLTF, useTexture } from "@react-three/drei";
import { useRef, useEffect } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

export default function PerfumeModel({ clicked, setClicked }) {
  const { scene } = useGLTF("/models/perfume.glb");
  const logoTexture = useTexture("/soulogoperfume.PNG");
  const ref = useRef();

  // Improve materials brightness
  useEffect(() => {
    scene.traverse((child) => {
      if (child.isMesh) {
        child.material.envMapIntensity = 2.5;
        child.material.roughness = 0.3;
        child.material.metalness = 0.6;
        if (child.material.color) {
          child.material.color.offsetHSL(0, 0, 0.15);
        }
      }
    });
  }, [scene]);

  useFrame(() => {
    if (!ref.current) return;

    const targetZ = 0; 
    const startZ = -20; 

    if (!ref.current.userData.started) {
      ref.current.position.z = startZ;
      ref.current.userData.started = true;
    }

    ref.current.position.z += (targetZ - ref.current.position.z) * 0.03;

    const targetScale = clicked ? 0.9 : 0.7;

    ref.current.scale.x += (targetScale - ref.current.scale.x) * 0.08;
    ref.current.scale.y += (targetScale - ref.current.scale.y) * 0.08;
    ref.current.scale.z += (targetScale - ref.current.scale.z) * 0.08;
  });

  return (
    <group ref={ref} position={[0, -1, 0]} scale={1.4}>
      <primitive object={scene} onClick={() => setClicked(!clicked)} />

      {/* Logo Plane */}
      <mesh position={[0, 1.4, 0.85]}>
        <planeGeometry args={[2.3, 3]} />
        <meshStandardMaterial
          map={logoTexture}
          transparent
          side={THREE.DoubleSide}
          depthWrite={false}
          roughness={0.2}
          metalness={0.6}
        />
      </mesh>
    </group>
  );
}
