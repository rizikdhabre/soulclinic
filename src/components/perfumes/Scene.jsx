"use client";

import { Canvas } from "@react-three/fiber";
import { Suspense, useState } from "react";
import {
  Environment,
  Float,
  ContactShadows,
  Stars,
  OrbitControls,
} from "@react-three/drei";
import PerfumeModel from "./PerfumeModel";
import Lights from "./Lights";

export default function Scene() {
  const [clicked, setClicked] = useState(false);

  return (
    <Canvas
     dpr={[1, 1.5]}       
      camera={{ position: [0, 0, 10], fov: 45 }}
      className="absolute inset-0"
    >
      <Suspense fallback={null}>
        <Environment preset="night" />

        <Lights />

        <Float speed={2} rotationIntensity={0.2} floatIntensity={0.4}>
          <PerfumeModel clicked={clicked} setClicked={setClicked} />
        </Float>

        <ContactShadows
          position={[0, -2, 0]}
          opacity={0.4}
          scale={10}
          blur={2}
          far={4}
        />

        <Stars radius={60} depth={40} count={200} factor={4} fade />

        <OrbitControls
          enableZoom={false}
          enablePan={false}
          minPolarAngle={Math.PI / 2.2}
          maxPolarAngle={Math.PI / 1.8}
        />
      </Suspense>
    </Canvas>
  );
}
