export default function Lights() {
  return (
    <>
      {/* Base ambient */}
      <ambientLight intensity={0.8} />

      {/* Strong top key light */}
      <spotLight
        position={[0, 8, 4]}
        angle={0.35}
        penumbra={1}
        intensity={4}
      />

      {/* Front fill light */}
      <pointLight
        position={[0, 2, 6]}
        intensity={3}
      />

      {/* Back rim light */}
      <pointLight
        position={[0, 3, -6]}
        intensity={4}
        color="#D4AF37"
      />

      {/* Side highlight */}
      <pointLight
        position={[5, 4, 2]}
        intensity={2}
      />
    </>
  );
}
