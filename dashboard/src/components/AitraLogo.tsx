import React from "react";
import aitraNavLogo from "../assets/aitra-nav-logo.png";
import aitraHeroOwl from "../assets/aitra-hero-owl.png";

export function AitraBrandHeader() {
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      <img
        src={aitraNavLogo}
        alt="AITRA"
        style={{
          height: "26px",
          width: "auto",
          display: "block",
          objectFit: "contain",
        }}
      />
    </div>
  );
}

export function AitraHeroIllustration({ width = 175 }: { width?: number }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <img
        src={aitraHeroOwl}
        alt="Aitra Owl Mascot"
        style={{
          width: `${width}px`,
          height: "auto",
          display: "block",
          objectFit: "contain",
          filter: "drop-shadow(0 4px 12px rgba(15, 23, 42, 0.06))",
        }}
      />
    </div>
  );
}
