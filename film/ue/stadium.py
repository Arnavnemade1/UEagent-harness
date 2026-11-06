"""Parametric football stadium generator for Unreal Engine 5 (Python, runs headless).

Builds a complete, lit stadium level from a JSON config: pitch with markings, goals with nets,
a continuous three-tier bowl (curved corners) with seats and an animated crowd, an LED ribbon and
suite band, a roof, a facade, a plaza and a city skyline. Everything is real geometry (meshes
generated through StaticMeshDescription) with procedural materials, so it needs no content packs.

Presets:
  "oculus"  - enclosed bowl with a pinwheel oculus roof: eight translucent petals around an open
              aperture and a 360-degree halo video board (inspired by modern domed stadiums such as
              Atlanta's; no real names, logos or branding).
  "classic" - four-sided bowl, open sky, cantilever roof ring and floodlight masts.

Run headless (the hfilm CLI does this for you: `hfilm ue stadium`):
  UnrealEditor-Cmd P.uproject -run=pythonscript -script=stadium.py -unattended -nullrhi
  with HFILM_STADIUM_JOB=/path/job.json  ({"map": "/Game/HFilm/Stadiums/Oculus", "preset": "oculus", ...})

Units: centimetres. Pitch centred on the origin, length along X, main camera side at -Y.
Outliner folders (for hfilm plates --hide / --holdouts):
  Stadium/Pitch (actor "Pitch" = ground for the shadow catcher), Stadium/Pitch/Goal_West|Goal_East
  (net material M_Net), Stadium/Pitch/CornerFlags, Stadium/Boards, Stadium/Bowl, Stadium/Seats,
  Stadium/Crowd, Stadium/Roof, Stadium/Halo, Stadium/Facade, Stadium/Lighting, Stadium/City
"""
import json
import math
import os
import random
import struct
import time
import zlib

import unreal

EAL = unreal.EditorAssetLibrary
MEL = unreal.MaterialEditingLibrary
AT = unreal.AssetToolsHelpers.get_asset_tools()
ACT = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
SDS = unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)
SDL = unreal.SubobjectDataBlueprintFunctionLibrary
MP = unreal.MaterialProperty
CM = unreal.CustomMaterialOutputType
CUBE = EAL.load_asset("/Engine/BasicShapes/Cube")
CYL = EAL.load_asset("/Engine/BasicShapes/Cylinder")
SPHERE = EAL.load_asset("/Engine/BasicShapes/Sphere")
LOWSPHERE = EAL.load_asset("/Engine/EngineMeshes/Sphere")   # 320 cm across
TAG = "HFilmStadium"
LOG = []


def note(msg):
    LOG.append(msg)
    unreal.log("[stadium] %s" % msg)


def V(x=0.0, y=0.0, z=0.0):
    return unreal.Vector(float(x), float(y), float(z))


def R(pitch=0.0, yaw=0.0, roll=0.0):
    r = unreal.Rotator()
    r.pitch, r.yaw, r.roll = float(pitch), float(yaw), float(roll)
    return r


def T(loc, rot=(0, 0, 0), scale=(1, 1, 1)):
    return unreal.Transform(V(*loc), R(*rot), V(*scale))


def hexcol(h, scale=1.0):
    h = h.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    lin = [(c / 12.92) if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return tuple(c * scale for c in lin)


# ====================================================================================== presets
PRESETS = {
    "oculus": {
        "pitch": {"length": 105.0, "width": 68.0, "runoffSide": 7.5, "runoffEnd": 10.0},
        "bowl": {"corner": 16.0, "shape": "rounded",
                 "tiers": [
                     {"name": "Lower", "rows": 28, "depth": 0.80, "rise": [0.32, 0.52], "front": 0.0, "z": 1.2, "seats": True, "fans": 0.8, "cheer": 0.12},
                     {"name": "Club", "rows": 10, "depth": 0.85, "rise": [0.48, 0.52], "front": 18.0, "z": 16.5, "seats": False, "crowdSurface": 0.7},
                     {"name": "Upper", "rows": 26, "depth": 0.88, "rise": [0.58, 0.66], "front": 28.0, "z": 26.5, "seats": False, "crowdSurface": 0.78},
                 ],
                 "suites": {"front": 26.5, "back": 30.0, "z": [21.5, 25.8]},
                 "back": 51.5},
        "roof": {"style": "oculus", "eave": 53.0, "zOuter": 47.0, "zInner": 55.0, "oculus": 40.0, "sides": 8, "petals": 8, "aperture": 21.0, "twist": 24.0,
                 "halo": {"radius": 45.5, "height": 12.0, "bottom": 34.0}},
        "facade": {"style": "angular", "window": "west"},
        "colors": {"home": "#b5121b", "away": "#eceef2", "seat": "#1b1c20", "accent": "#b5121b", "steel": "#2a2d33", "roof": "#c9ccd1"},
        "sun": {"elevation": 36.0, "azimuth": 52.0, "intensity": 7.5, "temperature": 4900},
        "lights": {"bowl": 4500.0},
        "city": True,
    },
    "classic": {
        "pitch": {"length": 105.0, "width": 68.0, "runoffSide": 7.5, "runoffEnd": 10.0},
        "bowl": {"corner": 6.0, "shape": "rounded",
                 "tiers": [{"name": "Lower", "rows": 30, "depth": 0.80, "rise": [0.33, 0.5], "front": 0.0, "z": 1.2, "seats": True, "fans": 0.8},
                           {"name": "Upper", "rows": 24, "depth": 0.85, "rise": [0.55, 0.62], "front": 22.0, "z": 16.0, "seats": False, "crowdSurface": 0.75}],
                 "suites": {"front": 20.0, "back": 23.0, "z": [12.5, 15.5]},
                 "back": 43.0},
        "roof": {"style": "ring", "eave": 45.0, "zOuter": 34.0, "zInner": 38.0, "oculus": 0.0, "inner": 14.0},
        "facade": {"style": "angular", "window": None},
        "colors": {"home": "#b5121b", "away": "#1b2a55", "seat": "#8a0f16", "accent": "#b5121b", "steel": "#2a2d33", "roof": "#d6d8dc"},
        "sun": {"elevation": 22.0, "azimuth": 52.0, "intensity": 8.0, "temperature": 4700},
        "lights": {"bowl": 4000.0},
        "city": True,
    },
}


def merge(a, b):
    out = dict(a)
    for k, v in (b or {}).items():
        out[k] = merge(a[k], v) if isinstance(v, dict) and isinstance(a.get(k), dict) else v
    return out


# ====================================================================================== materials
NOISE = r"""
struct NZ {
  float h21(float2 p) { p = fmod(abs(p), 289.0); p = frac(p * float2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return frac((p.x + p.y) * p.x); }
  float h31(float3 p) { p = fmod(abs(p), 289.0); p = frac(p * float3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return frac((p.x + p.y) * p.z); }
  float n2(float2 p) { float2 i = floor(p); float2 f = frac(p); float2 u = f * f * (3.0 - 2.0 * f);
    return lerp(lerp(h21(i), h21(i + float2(1, 0)), u.x), lerp(h21(i + float2(0, 1)), h21(i + float2(1, 1)), u.x), u.y); }
  float n3(float3 p) { float3 i = floor(p); float3 f = frac(p); float3 u = f * f * (3.0 - 2.0 * f);
    float a = lerp(lerp(h31(i), h31(i + float3(1, 0, 0)), u.x), lerp(h31(i + float3(0, 1, 0)), h31(i + float3(1, 1, 0)), u.x), u.y);
    float b = lerp(lerp(h31(i + float3(0, 0, 1)), h31(i + float3(1, 0, 1)), u.x), lerp(h31(i + float3(0, 1, 1)), h31(i + float3(1, 1, 1)), u.x), u.y);
    return lerp(a, b, u.z); }
  float fbm2(float2 p, int o) { float s = 0.0; float a = 0.5; for (int i = 0; i < o; i++) { s += a * n2(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
  float fbm3(float3 p, int o) { float s = 0.0; float a = 0.5; for (int i = 0; i < o; i++) { s += a * n3(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
};
NZ nz;
"""

GRASS_COLOR = NOISE + r"""
float2 p = P.xy;
float2 a = abs(p);
const float L = HALF_L; const float W = HALF_W; const float hw = 6.0;
float d = 1e6;
if (a.y <= W + hw) d = min(d, abs(a.x - L));
if (a.x <= L + hw) d = min(d, abs(a.y - W));
if (a.y <= W) d = min(d, abs(p.x));
float r = length(p);
d = min(d, abs(r - 915.0));
float gx = L - a.x;
if (a.y <= 2016.0 + hw) d = min(d, abs(gx - 1650.0));
if (gx >= 0.0 && gx <= 1650.0) d = min(d, abs(a.y - 2016.0));
if (a.y <= 916.0 + hw) d = min(d, abs(gx - 550.0));
if (gx >= 0.0 && gx <= 550.0) d = min(d, abs(a.y - 916.0));
float rs = length(float2(a.x - (L - 1100.0), p.y));
if (gx > 1650.0) d = min(d, abs(rs - 915.0));
float rc = length(float2(a.x - L, a.y - W));
if (a.x <= L && a.y <= W) d = min(d, abs(rc - 100.0));
float fine = nz.n2(p / 2.2);
float aa = max(fwidth(d), 0.6);
float edge = (nz.n2(p * 0.35) - 0.5) * 2.4;
float lines = 1.0 - smoothstep(hw - aa + edge, hw + aa + edge, d);
lines = max(lines, 1.0 - smoothstep(13.0, 16.0, min(r, rs)));
lines *= 0.86 + 0.14 * nz.n2(p * 0.9);
float band = fmod(floor((p.x + 52500.0) / 525.0), 2.0) * 2.0 - 1.0;
float2 vdir = -normalize(C.xy + float2(1e-4, 1e-4));
float grazing = saturate(1.15 - abs(C.z));
float stripe = 1.0 + 0.24 * grazing * band * vdir.x + 0.05 * band;
float big = nz.fbm2(p / 1500.0, 3);
float mid = nz.fbm2(p / 160.0, 3);
float3 dark = float3(0.028, 0.090, 0.016);
float3 lush = float3(0.052, 0.145, 0.026);
float3 dry = float3(0.105, 0.135, 0.042);
float3 g = lerp(dark, lush, saturate(mid * 1.5 - 0.25));
g = lerp(g, dry, saturate((big - 0.6) * 2.5) * 0.25);
g *= 0.84 + 0.32 * fine;
float2 gm = float2(a.x - (L - 260.0), p.y);
float wg = 1.0 - smoothstep(120.0, 560.0, length(gm * float2(1.0, 0.65)));
wg = max(wg, 0.18 * (1.0 - smoothstep(40.0, 220.0, r)));
float wear = saturate(wg * (nz.fbm2(p / 55.0, 3) * 1.7 - 0.3));
float3 soil = float3(0.15, 0.115, 0.075) * (0.8 + 0.4 * fine);
g = lerp(g, soil, wear * 0.55);
g *= stripe;
float inside = step(a.x, L + 400.0) * step(a.y, W + 400.0);
g *= lerp(0.82, 1.0, inside);
float3 paint = float3(0.80, 0.80, 0.78) * (0.93 + 0.07 * fine);
return lerp(g, paint, saturate(lines) * inside);
"""

GRASS_NORMAL = NOISE + r"""
float2 p = P.xy;
const float e = 0.5;
float h0 = nz.n2(p / 1.6) * 0.6 + nz.n2(p / 0.55) * 0.4;
float hx = nz.n2((p + float2(e, 0)) / 1.6) * 0.6 + nz.n2((p + float2(e, 0)) / 0.55) * 0.4;
float hy = nz.n2((p + float2(0, e)) / 1.6) * 0.6 + nz.n2((p + float2(0, e)) / 0.55) * 0.4;
float2 g = float2(hx - h0, hy - h0) * 1.8;
return normalize(float3(-g.x, -g.y, 1.0));
"""

CONCRETE = NOISE + r"""
float a = nz.fbm3(P / 45.0, 4);
float b = nz.n3(P / 2.5);
float st = nz.fbm3(P / 420.0, 3);
float drip = nz.n3(float3(P.x / 30.0, P.y / 30.0, P.z / 260.0));
float v = 0.72 + 0.38 * a + 0.10 * b - 0.28 * saturate(st - 0.52) - 0.12 * saturate(drip - 0.6);
return Tint * v;
"""

METAL = NOISE + r"""
float streak = nz.n2(float2((P.x + P.y) / 600.0, P.z / 8.0));
float spot = nz.fbm3(P / 90.0, 3);
return saturate(0.28 + 0.22 * streak + 0.18 * spot);
"""

SEAT = NOISE + r"""
float fade = 0.82 + 0.28 * Rnd;
float dirt = nz.n3(P / 12.0);
return Tint * fade * (0.9 + 0.12 * dirt);
"""

# fans: colour by section (home colours most places, away colours in the away end)
CROWD_COLOR = r"""
float2 cell = floor(OP.xy / 7.0);
float h = frac(sin(dot(cell, float2(12.9898, 78.233))) * 43758.5453);
float h2 = frac(h * 91.7 + 0.37);
bool away = OP.x > AWAY_X;
float3 c;
if (away) {
  c = h < 0.45 ? AWAY1 : (h < 0.72 ? AWAY2 : (h < 0.86 ? float3(0.03, 0.03, 0.035) : float3(0.25, 0.27, 0.3)));
} else {
  c = h < 0.5 ? HOME1 : (h < 0.62 ? HOME2 : (h < 0.74 ? float3(0.03, 0.03, 0.035) : (h < 0.84 ? float3(0.18, 0.2, 0.24) : (h < 0.91 ? float3(0.85, 0.85, 0.85) : float3(0.12, 0.16, 0.3)))));
}
float stripes = (h2 > 0.8) ? (0.75 + 0.25 * step(0.5, frac(LP.z / 18.0))) : 1.0;
return c * stripes;
"""

# seated fan figure (SM_Fan / SM_FanCheer): colour zones from the figure's local position (cm, origin at
# the tread, facing -Y): trousers below the hips, shirt, skin head and hands, hair or a cap on top
CROWD_FAN = r"""
float h = frac(Rnd * 7.13 + 0.17);
float h2 = frac(h * 91.7 + 0.37), h3 = frac(h * 57.31 + 0.11), h4 = frac(h * 13.77 + 0.5);
bool away = P.x > AWAY_X;
float3 shirt;
if (away) shirt = h < 0.4 ? AWAY1 : (h < 0.62 ? AWAY2 : (h < 0.76 ? float3(0.03, 0.03, 0.035) : (h < 0.88 ? float3(0.22, 0.24, 0.27) : float3(0.55, 0.5, 0.42))));
else shirt = h < 0.34 ? HOME1 : (h < 0.44 ? HOME2 : (h < 0.57 ? float3(0.025, 0.025, 0.03) : (h < 0.67 ? float3(0.2, 0.21, 0.23) : (h < 0.76 ? float3(0.82, 0.82, 0.8)
           : (h < 0.84 ? float3(0.06, 0.1, 0.24) : (h < 0.91 ? float3(0.42, 0.36, 0.27) : float3(0.2, 0.32, 0.5)))))));
float3 skin = h3 < 0.3 ? float3(0.62, 0.43, 0.33) : (h3 < 0.55 ? float3(0.80, 0.62, 0.50) : (h3 < 0.8 ? float3(0.36, 0.22, 0.14) : float3(0.50, 0.33, 0.22)));
float3 hair = h4 < 0.5 ? float3(0.02, 0.015, 0.01) : (h4 < 0.8 ? float3(0.12, 0.07, 0.035) : float3(0.45, 0.33, 0.15));
float3 legs = h2 < 0.6 ? float3(0.03, 0.035, 0.05) : (h2 < 0.85 ? float3(0.07, 0.1, 0.18) : float3(0.3, 0.28, 0.24));
// height in the figure's own mesh space (pre-instance position)
float z = LP.z;
float3 c = shirt;
if (z < 60.0) c = legs;
if (z > 113.0 && z < 140.0) c = skin;
if (z > 155.0) c = skin;                                   // raised hands
if (z > 131.0 && z < 140.0) c = (h2 > 0.82) ? HOME1 : hair;
if (h2 > 0.7 && h2 < 0.82 && z > 104.0 && z < 113.0) c = away ? AWAY1 : HOME1;   // scarves
return c * (0.85 + 0.3 * h4);
"""

CROWD_WPO = r"""
float ph = frac(Rnd * 3.17 + 0.41);
float bob = sin(Tm * (1.2 + ph) + ph * 6.283) * 1.2;
float cheer = smoothstep(0.82, 1.0, sin(Tm * 0.35 + ph * 25.0));
float jump = cheer * abs(sin(Tm * 8.0 + ph * 6.283)) * 14.0;
float sway = sin(Tm * 0.9 + ph * 12.0) * 1.5;
return float3(sway, sway * 0.5, bob + jump);
"""

HEAD_COLOR = r"""
float2 cell = floor(OP.xy / 7.0);
float h = frac(sin(dot(cell, float2(7.13, 157.1))) * 43758.5453);
float3 skin = h < 0.3 ? float3(0.62, 0.43, 0.33) : (h < 0.55 ? float3(0.80, 0.62, 0.50) : (h < 0.8 ? float3(0.36, 0.22, 0.14) : float3(0.50, 0.33, 0.22)));
float hh = frac(h * 57.3);
float3 hair = hh < 0.5 ? float3(0.02, 0.015, 0.01) : (hh < 0.8 ? float3(0.12, 0.07, 0.035) : float3(0.45, 0.33, 0.15));
float capped = step(0.85, frac(h * 13.7));
float top = smoothstep(30.0, 60.0, LP.z);
return lerp(skin, capped > 0.5 ? HOME1 : hair, top);
"""

# distant tiers: a crowd painted onto the steps (one person per 50 cm seat cell), cheap and convincing
CROWD_SURFACE = NOISE + r"""
float2 q = P.xy / 50.0;
float2 cell = floor(q);
float h = frac(sin(dot(cell, float2(12.9898, 78.233))) * 43758.5453);
float occ = step(h, Occ);
float3 seat = Seat * (0.8 + 0.3 * nz.n2(cell * 0.3));
float k = frac(h * 37.1);
bool away = P.x > AWAY_X;
float3 shirt = away ? (k < 0.5 ? AWAY1 : (k < 0.75 ? AWAY2 : float3(0.05, 0.05, 0.06)))
                    : (k < 0.36 ? HOME1 : (k < 0.46 ? HOME2 : (k < 0.62 ? float3(0.05, 0.05, 0.06) : (k < 0.72 ? float3(0.22, 0.22, 0.24) : (k < 0.82 ? float3(0.7, 0.7, 0.7) : (k < 0.9 ? float3(0.15, 0.18, 0.3) : float3(0.4, 0.35, 0.27)))))));
float2 f = frac(q) - 0.5;
float body = 1.0 - smoothstep(0.30, 0.42, length(f * float2(1.0, 0.8)));
float3 skin = lerp(float3(0.6, 0.42, 0.32), float3(0.3, 0.19, 0.12), frac(h * 11.3));
float head = 1.0 - smoothstep(0.10, 0.16, length(f - float2(0.0, 0.18)));
float3 person = lerp(shirt * (0.75 + 0.35 * frac(h * 5.1)), skin, head * 0.85);
return lerp(seat, person, occ * saturate(body + head));
"""

LED = r"""
float x = UV.x * Reps - Tm * 0.12;
float seg = floor(x);
float h = frac(sin(seg * 12.9898) * 43758.5453);
float3 c = h < 0.3 ? HOME1 : (h < 0.5 ? float3(0.9, 0.9, 0.9) : (h < 0.75 ? AWAY1 : float3(1.0, 0.7, 0.0)));
float fx = frac(x);
float band = step(0.18, UV.y) * step(UV.y, 0.82) * step(0.06, fx) * step(fx, 0.94);
float chevron = step(0.5, frac(fx * 6.0 + abs(UV.y - 0.5) * 3.0));
float2 px = frac(UV * float2(Reps * 170.0, 48.0)) - 0.5;
float led = 1.0 - smoothstep(0.32, 0.5, length(px));
return c * lerp(0.05, 1.0, band * lerp(0.5, 1.0, chevron)) * lerp(0.35, 1.0, led);
"""

BUILDING_COLOR = NOISE + r"""
float3 n = abs(N);
if (n.z > 0.6) return float3(0.18, 0.18, 0.19) * (0.8 + 0.3 * nz.n2(P.xy / 300.0));
float2 uv = (n.x > n.y) ? P.yz : P.xz;
float2 cell = floor(uv / float2(300.0, 360.0));
float2 f = frac(uv / float2(300.0, 360.0));
float win = step(0.12, f.x) * step(f.x, 0.88) * step(0.18, f.y) * step(f.y, 0.86);
float3 frame = float3(0.22, 0.22, 0.23) * (0.85 + 0.25 * nz.n2(cell * 0.37));
float3 glass = float3(0.025, 0.03, 0.04);
return lerp(frame, glass, win);
"""

BUILDING_EMISSIVE = r"""
float3 n = abs(N);
if (n.z > 0.6) return float3(0, 0, 0);
float2 uv = (n.x > n.y) ? P.yz : P.xz;
float2 cell = floor(uv / float2(300.0, 360.0));
float2 f = frac(uv / float2(300.0, 360.0));
float win = step(0.12, f.x) * step(f.x, 0.88) * step(0.18, f.y) * step(f.y, 0.86);
float h = frac(sin(dot(cell + floor(P.z / 5000.0), float2(12.9898, 78.233))) * 43758.5453);
float lit = step(0.93, h);
float3 warm = lerp(float3(1.0, 0.72, 0.42), float3(0.85, 0.9, 1.0), step(0.97, h));
return warm * lit * win * (0.4 + 0.8 * frac(h * 7.1));
"""

# suites / concourse glazing: dark glass with warm interior bays
GLASS_COLOR = r"""
return float3(0.02, 0.025, 0.03);
"""
GLASS_EMISSIVE = NOISE + r"""
float bay = floor(Along / 600.0);
float h = frac(sin(bay * 12.9898) * 43758.5453);
float mull = step(0.06, frac(Along / 150.0)) * step(frac(Along / 150.0), 0.94);
float band = step(0.08, frac(P.z / 420.0)) * step(frac(P.z / 420.0), 0.9);
float3 warm = lerp(float3(1.0, 0.78, 0.55), float3(0.8, 0.86, 1.0), step(0.8, h));
return warm * (0.25 + 0.75 * step(0.2, h)) * mull * band * Glow;
"""

NET = r"""
float3 n = abs(N);
float2 uv = (n.x > 0.5) ? P.yz : ((n.y > 0.5) ? P.xz : P.xy);
float2 f = abs(frac(uv / 10.0) - 0.5);
return (max(f.x, f.y) > 0.468) ? 1.0 : 0.0;
"""

# translucent roof membrane (ETFE petals): bright where the sun comes through
ETFE_COLOR = NOISE + r"""
float cells = nz.n2(P.xy / 900.0);
float2 f = abs(frac(P.xy / 450.0) - 0.5);
float seam = step(0.47, max(f.x, f.y));
return lerp(float3(0.82, 0.85, 0.88) * (0.9 + 0.15 * cells), float3(0.25, 0.27, 0.3), seam);
"""

# the halo board: a strip texture scrolls around the ring, with visible LED pixels
HALO = r"""
float2 uv = float2(frac(UV.x * Reps + Tm * 0.004), UV.y);
float3 c = Tex;
float2 px = frac(float2(UV.x * Reps * 2048.0, UV.y * 128.0)) - 0.5;
float led = 1.0 - smoothstep(0.34, 0.5, length(px));
return c * lerp(0.45, 1.0, led);
"""


def _material(name, folder):
    path = "%s/%s" % (folder, name)
    if EAL.does_asset_exist(path):
        m = EAL.load_asset(path)
        MEL.delete_all_material_expressions(m)
        return m
    return AT.create_asset(name, folder, unreal.Material, unreal.MaterialFactoryNew())


def _expr(m, cls, x, y, **props):
    e = MEL.create_material_expression(m, cls, x, y)
    for k, v in props.items():
        e.set_editor_property(k, v)
    return e


def _custom(m, code, inputs, out_type, x=-500, y=0):
    c = _expr(m, unreal.MaterialExpressionCustom, x, y, code=code, output_type=out_type)
    ins = []
    for n in inputs:
        ci = unreal.CustomInput()
        ci.set_editor_property("input_name", n)
        ins.append(ci)
    c.set_editor_property("inputs", ins)
    return c


def _const(m, v, x, y):
    return _expr(m, unreal.MaterialExpressionConstant, x, y, r=float(v))


def _vec(m, name, rgb, x, y):
    return _expr(m, unreal.MaterialExpressionVectorParameter, x, y, parameter_name=name, default_value=unreal.LinearColor(rgb[0], rgb[1], rgb[2], 1))


def _scalar(m, name, v, x, y):
    return _expr(m, unreal.MaterialExpressionScalarParameter, x, y, parameter_name=name, default_value=float(v))


def _finish(m, two_sided=True):
    for flag in ("used_with_instanced_static_meshes", "used_with_static_lighting"):
        try:
            m.set_editor_property(flag, True)
        except Exception:
            pass
    if two_sided:
        try:
            m.set_editor_property("two_sided", True)
        except Exception:
            pass
    MEL.layout_material_expressions(m)
    MEL.recompile_material(m)
    EAL.save_loaded_asset(m, False)
    return m


def _mi(name, parent, folder, vectors=None, scalars=None):
    path = "%s/%s" % (folder, name)
    mi = EAL.load_asset(path) if EAL.does_asset_exist(path) else AT.create_asset(name, folder, unreal.MaterialInstanceConstant, unreal.MaterialInstanceConstantFactoryNew())
    MEL.set_material_instance_parent(mi, parent)
    for k, v in (vectors or {}).items():
        MEL.set_material_instance_vector_parameter_value(mi, k, unreal.LinearColor(v[0], v[1], v[2], 1))
    for k, v in (scalars or {}).items():
        MEL.set_material_instance_scalar_parameter_value(mi, k, v)
    MEL.update_material_instance(mi)
    EAL.save_loaded_asset(mi, False)
    return mi


def _f3(rgb):
    return "float3(%.4f, %.4f, %.4f)" % tuple(rgb)


def build_materials(cfg, folder, halo_tex=None):
    """All stadium materials; returns {name: material}."""
    C = cfg["colors"]
    home1, away1 = hexcol(C["home"]), hexcol(C["away"])
    home2 = tuple(min(1.0, c * 0.35 + 0.55) for c in home1) if sum(home1) < 0.9 else (0.03, 0.03, 0.035)
    away2 = (0.85, 0.86, 0.9) if sum(away1) < 1.5 else (0.03, 0.04, 0.10)
    team = lambda code: (code.replace("HOME1", _f3(home1)).replace("HOME2", _f3(home2)).replace("AWAY1", _f3(away1)).replace("AWAY2", _f3(away2))
                         .replace("AWAY_X", "%.1f" % (cfg["pitch"]["length"] * 50 + cfg["pitch"]["runoffEnd"] * 100 - 1.0)))
    L, W = cfg["pitch"]["length"] * 50.0, cfg["pitch"]["width"] * 50.0
    M = {}

    m = _material("M_Grass", folder)
    wp = _expr(m, unreal.MaterialExpressionWorldPosition, -1100, 0)
    cv = _expr(m, unreal.MaterialExpressionCameraVectorWS, -1100, 150)
    c = _custom(m, GRASS_COLOR.replace("HALF_L", "%.1f" % L).replace("HALF_W", "%.1f" % W), ["P", "C"], CM.CMOT_FLOAT3, -600, 0)
    MEL.connect_material_expressions(wp, "", c, "P")
    MEL.connect_material_expressions(cv, "", c, "C")
    MEL.connect_material_property(c, "", MP.MP_BASE_COLOR)
    n = _custom(m, GRASS_NORMAL, ["P"], CM.CMOT_FLOAT3, -600, 300)
    MEL.connect_material_expressions(wp, "", n, "P")
    MEL.connect_material_property(n, "", MP.MP_NORMAL)
    MEL.connect_material_property(_const(m, 0.88, -300, 450), "", MP.MP_ROUGHNESS)
    MEL.connect_material_property(_const(m, 0.4, -300, 550), "", MP.MP_SPECULAR)
    M["grass"] = _finish(m)

    for name, code, out in (("M_Concrete", CONCRETE, "color"), ("M_Metal", METAL, "rough")):
        m = _material(name, folder)
        wp = _expr(m, unreal.MaterialExpressionWorldPosition, -1100, 0)
        tint = _vec(m, "Tint", (0.32, 0.31, 0.30), -1100, 200)
        if out == "color":
            c = _custom(m, code, ["P", "Tint"], CM.CMOT_FLOAT3, -600, 0)
            MEL.connect_material_expressions(wp, "", c, "P")
            MEL.connect_material_expressions(tint, "", c, "Tint")
            MEL.connect_material_property(c, "", MP.MP_BASE_COLOR)
            MEL.connect_material_property(_scalar(m, "Roughness", 0.86, -300, 300), "", MP.MP_ROUGHNESS)
        else:
            c = _custom(m, code, ["P"], CM.CMOT_FLOAT1, -600, 100)
            MEL.connect_material_expressions(wp, "", c, "P")
            MEL.connect_material_property(tint, "", MP.MP_BASE_COLOR)
            MEL.connect_material_property(c, "", MP.MP_ROUGHNESS)
            MEL.connect_material_property(_scalar(m, "Metallic", 0.9, -600, 300), "", MP.MP_METALLIC)
        M[name] = _finish(m)

    m = _material("M_Seat", folder)
    wp = _expr(m, unreal.MaterialExpressionWorldPosition, -1100, 0)
    rnd = _expr(m, unreal.MaterialExpressionPerInstanceRandom, -1100, 150)
    tint = _vec(m, "Tint", hexcol(C["seat"]), -1100, 300)
    c = _custom(m, SEAT, ["P", "Rnd", "Tint"], CM.CMOT_FLOAT3, -600, 0)
    for src, pin in ((wp, "P"), (rnd, "Rnd"), (tint, "Tint")):
        MEL.connect_material_expressions(src, "", c, pin)
    MEL.connect_material_property(c, "", MP.MP_BASE_COLOR)
    MEL.connect_material_property(_const(m, 0.42, -300, 300), "", MP.MP_ROUGHNESS)
    M["seat"] = _finish(m)

    for name, code in (("M_CrowdBody", CROWD_COLOR), ("M_CrowdHead", HEAD_COLOR)):
        m = _material(name, folder)
        op = _expr(m, unreal.MaterialExpressionObjectPositionWS, -1100, 0)
        lp = _expr(m, unreal.MaterialExpressionLocalPosition, -1100, 150)
        tm = _expr(m, unreal.MaterialExpressionTime, -1100, 300)
        c = _custom(m, team(code), ["OP", "LP"], CM.CMOT_FLOAT3, -600, 0)
        MEL.connect_material_expressions(op, "", c, "OP")
        MEL.connect_material_expressions(lp, "", c, "LP")
        MEL.connect_material_property(c, "", MP.MP_BASE_COLOR)
        w = _custom(m, CROWD_WPO, ["Rnd", "Tm"], CM.CMOT_FLOAT3, -600, 300)
        MEL.connect_material_expressions(_expr(m, unreal.MaterialExpressionPerInstanceRandom, -1100, 450), "", w, "Rnd")
        MEL.connect_material_expressions(tm, "", w, "Tm")
        MEL.connect_material_property(w, "", MP.MP_WORLD_POSITION_OFFSET)
        MEL.connect_material_property(_const(m, 0.75, -300, 500), "", MP.MP_ROUGHNESS)
        M[name] = _finish(m)

    # per-instance identity comes from PerInstanceRandom (ObjectPositionWS is the component origin for
    # instanced meshes), body zones from the pre-instance (mesh-local) position
    m = _material("M_Fan", folder)
    rn = _expr(m, unreal.MaterialExpressionPerInstanceRandom, -1100, 0)
    lp0 = _expr(m, unreal.MaterialExpressionPreSkinnedPosition, -1300, 150)
    lp = _expr(m, unreal.MaterialExpressionVertexInterpolator, -1100, 150)   # vertex-only input -> pixel shader
    MEL.connect_material_expressions(lp0, "", lp, "")
    wp = _expr(m, unreal.MaterialExpressionWorldPosition, -1100, 300)
    tm = _expr(m, unreal.MaterialExpressionTime, -1100, 450)
    c = _custom(m, team(CROWD_FAN), ["Rnd", "LP", "P"], CM.CMOT_FLOAT3, -600, 0)
    MEL.connect_material_expressions(rn, "", c, "Rnd")
    MEL.connect_material_expressions(lp, "", c, "LP")
    MEL.connect_material_expressions(wp, "", c, "P")
    MEL.connect_material_property(c, "", MP.MP_BASE_COLOR)
    w = _custom(m, CROWD_WPO, ["Rnd", "Tm"], CM.CMOT_FLOAT3, -600, 300)
    MEL.connect_material_expressions(rn, "", w, "Rnd")
    MEL.connect_material_expressions(tm, "", w, "Tm")
    MEL.connect_material_property(w, "", MP.MP_WORLD_POSITION_OFFSET)
    MEL.connect_material_property(_const(m, 0.8, -300, 500), "", MP.MP_ROUGHNESS)
    M["fan"] = _finish(m)

    m = _material("M_CrowdSurface", folder)
    wp = _expr(m, unreal.MaterialExpressionWorldPosition, -1100, 0)
    seat = _vec(m, "Seat", hexcol(C["seat"]), -1100, 150)
    occ = _scalar(m, "Occ", 0.75, -1100, 300)
    c = _custom(m, team(CROWD_SURFACE), ["P", "Seat", "Occ"], CM.CMOT_FLOAT3, -600, 0)
    for src, pin in ((wp, "P"), (seat, "Seat"), (occ, "Occ")):
        MEL.connect_material_expressions(src, "", c, pin)
    MEL.connect_material_property(c, "", MP.MP_BASE_COLOR)
    MEL.connect_material_property(_const(m, 0.8, -300, 300), "", MP.MP_ROUGHNESS)
    M["crowdSurface"] = _finish(m)

    m = _material("M_LED", folder)
    uv = _expr(m, unreal.MaterialExpressionTextureCoordinate, -1100, 0)
    tm = _expr(m, unreal.MaterialExpressionTime, -1100, 150)
    reps = _scalar(m, "Reps", 14.0, -1100, 300)
    c = _custom(m, team(LED), ["UV", "Tm", "Reps"], CM.CMOT_FLOAT3, -600, 0)
    for src, pin in ((uv, "UV"), (tm, "Tm"), (reps, "Reps")):
        MEL.connect_material_expressions(src, "", c, pin)
    mul = _expr(m, unreal.MaterialExpressionMultiply, -300, 0)
    MEL.connect_material_expressions(c, "", mul, "A")
    MEL.connect_material_expressions(_scalar(m, "Brightness", 6.0, -600, 250), "", mul, "B")
    MEL.connect_material_property(mul, "", MP.MP_EMISSIVE_COLOR)
    MEL.connect_material_property(_const(m, 0.02, -300, 300), "", MP.MP_BASE_COLOR)
    MEL.connect_material_property(_const(m, 0.25, -300, 400), "", MP.MP_ROUGHNESS)
    M["led"] = _finish(m)

    m = _material("M_Lamp", folder)
    MEL.connect_material_property(_vec(m, "Color", (0.9, 0.92, 1.0), -600, 0), "", MP.MP_BASE_COLOR)
    em = _expr(m, unreal.MaterialExpressionMultiply, -300, 100)
    MEL.connect_material_expressions(_vec(m, "Light", (1.0, 0.97, 0.92), -600, 100), "", em, "A")
    MEL.connect_material_expressions(_scalar(m, "Brightness", 3.0, -600, 250), "", em, "B")
    MEL.connect_material_property(em, "", MP.MP_EMISSIVE_COLOR)
    M["lamp"] = _finish(m)

    m = _material("M_Building", folder)
    wp = _expr(m, unreal.MaterialExpressionWorldPosition, -1100, 0)
    nw = _expr(m, unreal.MaterialExpressionVertexNormalWS, -1100, 150)
    c = _custom(m, BUILDING_COLOR, ["P", "N"], CM.CMOT_FLOAT3, -600, 0)
    e = _custom(m, BUILDING_EMISSIVE, ["P", "N"], CM.CMOT_FLOAT3, -600, 250)
    for node in (c, e):
        MEL.connect_material_expressions(wp, "", node, "P")
        MEL.connect_material_expressions(nw, "", node, "N")
    MEL.connect_material_property(c, "", MP.MP_BASE_COLOR)
    MEL.connect_material_property(e, "", MP.MP_EMISSIVE_COLOR)
    MEL.connect_material_property(_const(m, 0.35, -300, 450), "", MP.MP_ROUGHNESS)
    M["building"] = _finish(m)

    # glazing: "Along" comes from the mesh UV (metres along the facade * 100)
    m = _material("M_Glazing", folder)
    wp = _expr(m, unreal.MaterialExpressionWorldPosition, -1100, 0)
    uv = _expr(m, unreal.MaterialExpressionTextureCoordinate, -1100, 150)
    along = _expr(m, unreal.MaterialExpressionComponentMask, -900, 150, r=True, g=False, b=False, a=False)
    MEL.connect_material_expressions(uv, "", along, "")
    glow = _scalar(m, "Glow", 2.5, -1100, 300)
    e = _custom(m, GLASS_EMISSIVE, ["P", "Along", "Glow"], CM.CMOT_FLOAT3, -600, 100)
    for src, pin in ((wp, "P"), (along, "Along"), (glow, "Glow")):
        MEL.connect_material_expressions(src, "", e, pin)
    MEL.connect_material_property(_vec(m, "Tint", (0.02, 0.025, 0.03), -600, 0), "", MP.MP_BASE_COLOR)
    MEL.connect_material_property(e, "", MP.MP_EMISSIVE_COLOR)
    MEL.connect_material_property(_const(m, 0.06, -300, 400), "", MP.MP_ROUGHNESS)
    MEL.connect_material_property(_const(m, 0.6, -300, 500), "", MP.MP_METALLIC)
    M["glazing"] = _finish(m)

    m = _material("M_Net", folder)
    m.set_editor_property("blend_mode", unreal.BlendMode.BLEND_MASKED)
    m.set_editor_property("two_sided", True)
    wp = _expr(m, unreal.MaterialExpressionWorldPosition, -1100, 0)
    nw = _expr(m, unreal.MaterialExpressionVertexNormalWS, -1100, 150)
    c = _custom(m, NET, ["P", "N"], CM.CMOT_FLOAT1, -600, 0)
    MEL.connect_material_expressions(wp, "", c, "P")
    MEL.connect_material_expressions(nw, "", c, "N")
    MEL.connect_material_property(c, "", MP.MP_OPACITY_MASK)
    MEL.connect_material_property(_vec(m, "Color", (0.85, 0.85, 0.85), -600, 200), "", MP.MP_BASE_COLOR)
    M["net"] = _finish(m)

    # ETFE membrane: masked with temporal dither (reads as translucent once Movie Render Queue averages
    # its samples, casts soft partial shadows). True translucency here blew up into NaN glare under Lumen.
    m = _material("M_ETFE", folder)
    m.set_editor_property("blend_mode", unreal.BlendMode.BLEND_MASKED)
    m.set_editor_property("two_sided", True)
    wp = _expr(m, unreal.MaterialExpressionWorldPosition, -1100, 0)
    c = _custom(m, ETFE_COLOR, ["P"], CM.CMOT_FLOAT3, -600, 0)
    MEL.connect_material_expressions(wp, "", c, "P")
    MEL.connect_material_property(c, "", MP.MP_BASE_COLOR)
    sp = _expr(m, unreal.MaterialExpressionScreenPosition, -900, 200)
    tm = _expr(m, unreal.MaterialExpressionTime, -900, 350)
    dither = _custom(m, "float h = frac(sin(dot(floor(SP.xy) + frac(Tm * 7.31) * 113.0, float2(12.9898, 78.233))) * 43758.5453); return step(h, Op);", ["SP", "Tm", "Op"], CM.CMOT_FLOAT1, -500, 200)
    MEL.connect_material_expressions(sp, "PixelPosition", dither, "SP")
    MEL.connect_material_expressions(tm, "", dither, "Tm")
    MEL.connect_material_expressions(_scalar(m, "Opacity", 0.86, -700, 450), "", dither, "Op")
    MEL.connect_material_property(dither, "", MP.MP_OPACITY_MASK)
    MEL.connect_material_property(_const(m, 0.75, -300, 450), "", MP.MP_ROUGHNESS)
    M["etfe"] = _finish(m)

    if halo_tex:
        m = _material("M_Halo", folder)
        m.set_editor_property("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)
        uv = _expr(m, unreal.MaterialExpressionTextureCoordinate, -1300, 0)
        tm = _expr(m, unreal.MaterialExpressionTime, -1300, 150)
        reps = _scalar(m, "Reps", 2.0, -1300, 300)
        # scrolled UV for the texture sample
        scroll = _custom(m, "return float2(frac(UV.x * Reps + Tm * 0.004), UV.y);", ["UV", "Tm", "Reps"], CM.CMOT_FLOAT2, -1000, 0)
        for src, pin in ((uv, "UV"), (tm, "Tm"), (reps, "Reps")):
            MEL.connect_material_expressions(src, "", scroll, pin)
        ts = _expr(m, unreal.MaterialExpressionTextureSample, -800, 0, texture=halo_tex)
        MEL.connect_material_expressions(scroll, "", ts, "UVs")
        c = _custom(m, HALO, ["UV", "Tm", "Reps", "Tex"], CM.CMOT_FLOAT3, -500, 0)
        for src, pin in ((uv, "UV"), (tm, "Tm"), (reps, "Reps")):
            MEL.connect_material_expressions(src, "", c, pin)
        MEL.connect_material_expressions(ts, "RGB", c, "Tex")
        mul = _expr(m, unreal.MaterialExpressionMultiply, -250, 0)
        MEL.connect_material_expressions(c, "", mul, "A")
        MEL.connect_material_expressions(_scalar(m, "Brightness", 2.2, -500, 250), "", mul, "B")
        MEL.connect_material_property(mul, "", MP.MP_EMISSIVE_COLOR)
        M["halo"] = _finish(m)

    # instances
    con, met = M["M_Concrete"], M["M_Metal"]
    M["concrete"] = _mi("MI_ConcreteLight", con, folder, {"Tint": (0.36, 0.35, 0.33)})
    M["concreteDark"] = _mi("MI_ConcreteDark", con, folder, {"Tint": (0.13, 0.13, 0.13)})
    M["plaza"] = _mi("MI_Plaza", con, folder, {"Tint": (0.2, 0.205, 0.21)})
    M["asphalt"] = _mi("MI_Asphalt", con, folder, {"Tint": (0.05, 0.05, 0.055)}, {"Roughness": 0.8})
    M["park"] = _mi("MI_Park", con, folder, {"Tint": (0.05, 0.075, 0.03)}, {"Roughness": 0.95})
    M["roofTop"] = _mi("MI_RoofTop", con, folder, {"Tint": (0.40, 0.44, 0.50)}, {"Roughness": 0.85})
    M["panel"] = _mi("MI_FacadePanel", met, folder, {"Tint": (0.30, 0.33, 0.37)}, {"Metallic": 0.15})
    M["steel"] = _mi("MI_Steel", met, folder, {"Tint": hexcol(C["steel"])}, {"Metallic": 0.75})
    M["white"] = _mi("MI_WhiteSteel", met, folder, {"Tint": (0.75, 0.76, 0.78)}, {"Metallic": 0.0})
    M["membrane"] = _mi("MI_Membrane", con, folder, {"Tint": (0.82, 0.83, 0.85)}, {"Roughness": 0.95})
    M["accent"] = _mi("MI_Accent", met, folder, {"Tint": hexcol(C["accent"])}, {"Metallic": 0.3})
    M["post"] = _mi("MI_Post", met, folder, {"Tint": (0.92, 0.92, 0.92)}, {"Metallic": 0.0})
    M["flood"] = M["lamp"]
    M["suiteGlass"] = _mi("MI_SuiteGlass", M["glazing"], folder, scalars={"Glow": 0.9})
    M["facadeGlass"] = _mi("MI_FacadeGlass", M["glazing"], folder, scalars={"Glow": 0.35})
    M["upperCrowd"] = _mi("MI_UpperCrowd", M["crowdSurface"], folder, {"Seat": hexcol(C["seat"])}, {"Occ": 0.78})
    M["clubCrowd"] = _mi("MI_ClubCrowd", M["crowdSurface"], folder, {"Seat": hexcol(C["seat"])}, {"Occ": 0.7})
    M["ribbon"] = _mi("MI_Ribbon", M["led"], folder, scalars={"Reps": 60.0, "Brightness": 4.0})
    M["boards"] = _mi("MI_Boards", M["led"], folder, scalars={"Reps": 14.0, "Brightness": 6.0})
    return M


# ====================================================================================== meshes
class Mesh:
    """Triangle soup -> StaticMesh asset (one polygon group per material slot)."""

    def __init__(self, name):
        self.name, self.groups = name, {}

    def tri(self, slot, a, b, c, uv=((0, 0), (1, 0), (0, 1))):
        self.groups.setdefault(slot, []).append((a, b, c, uv))

    def quad(self, slot, a, b, c, d, uv=((0, 0), (1, 0), (1, 1), (0, 1))):
        """a-b-c-d counter-clockwise seen from the front (Unreal: front = clockwise in screen)."""
        self.tri(slot, a, b, c, (uv[0], uv[1], uv[2]))
        self.tri(slot, a, c, d, (uv[0], uv[2], uv[3]))

    def box(self, slot, center, size, yaw=0.0):
        cx, cy, cz = center
        sx, sy, sz = size[0] / 2, size[1] / 2, size[2] / 2
        ca, sa = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))
        P = lambda x, y, z: (cx + x * ca - y * sa, cy + x * sa + y * ca, cz + z)
        c = [P(x, y, z) for z in (-sz, sz) for y in (-sy, sy) for x in (-sx, sx)]
        for f in ((0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)):
            self.quad(slot, c[f[0]], c[f[1]], c[f[2]], c[f[3]])

    def count(self):
        return sum(len(v) for v in self.groups.values())

    def build(self, folder, materials):
        path = "%s/%s" % (folder, self.name)
        if EAL.does_asset_exist(path):
            EAL.delete_asset(path)
        sm = AT.create_asset(self.name, folder, unreal.StaticMesh, None)
        slots = list(self.groups)
        sm.set_editor_property("static_materials", [unreal.StaticMaterial(material_interface=materials[s], material_slot_name=s) for s in slots])
        desc = unreal.StaticMesh.create_static_mesh_description(sm)
        for s in slots:
            pg = desc.create_polygon_group()
            desc.set_polygon_group_material_slot_name(pg, s)
            for a, b, c, uv in self.groups[s]:
                vs = []
                for p in (a, b, c):
                    v = desc.create_vertex()
                    desc.set_vertex_position(v, V(*p))
                    vs.append(v)
                vis = [desc.create_vertex_instance(v) for v in vs]
                for k, vi in enumerate(vis):
                    desc.set_vertex_instance_uv(vi, unreal.Vector2D(uv[k][0], uv[k][1]), 0)
                desc.create_triangle(pg, vis)
        sm.build_from_static_mesh_descriptions([desc], False, True)
        try:
            sm.set_editor_property("light_map_resolution", 64)
        except Exception:
            pass
        EAL.save_loaded_asset(sm, False)
        return sm


# ====================================================================================== actors
def clear_level():
    victims = [a for a in ACT.get_all_level_actors() if TAG in [str(t) for t in a.get_editor_property("tags")]]
    if victims:
        ACT.destroy_actors(victims)


def _tag(a, label, folder):
    a.set_actor_label(label)
    a.set_folder_path(folder)
    a.set_editor_property("tags", [TAG])
    return a


def mesh_actor(label, folder, sm, loc=(0, 0, 0), shadows=True):
    a = ACT.spawn_actor_from_class(unreal.StaticMeshActor, V(*loc), R())
    a.static_mesh_component.set_static_mesh(sm)
    a.static_mesh_component.set_editor_property("cast_shadow", shadows)
    return _tag(a, label, folder)


def box(label, folder, center, size, material, rot=None, mesh=None, shadows=True):
    a = ACT.spawn_actor_from_class(unreal.StaticMeshActor, V(*center), rot or R())
    c = a.static_mesh_component
    c.set_static_mesh(mesh or CUBE)
    c.set_material(0, material)
    c.set_editor_property("cast_shadow", shadows)
    a.set_actor_scale3d(V(size[0] / 100.0, size[1] / 100.0, size[2] / 100.0))
    return _tag(a, label, folder)


def cyl(label, folder, center, diameter, length, material, rot=None, shadows=True):
    return box(label, folder, center, (diameter, diameter, length), material, rot, CYL, shadows)


def ism(label, folder, mesh, material, transforms, shadows=False):
    a = ACT.spawn_actor_from_class(unreal.StaticMeshActor, V(), R())
    root = SDS.k2_gather_subobject_data_for_instance(a)[0]
    params = unreal.AddNewSubobjectParams()
    params.set_editor_property("parent_handle", root)
    params.set_editor_property("new_class", unreal.InstancedStaticMeshComponent)
    handle, fail = SDS.add_new_subobject(params)
    comp = SDL.get_object(SDL.get_data(handle))
    comp.set_static_mesh(mesh)
    if material is not None:
        comp.set_material(0, material)
    comp.set_editor_property("cast_shadow", shadows)
    try:
        comp.add_instances(transforms, False, False)
    except Exception:
        for t in transforms:
            comp.add_instance(t)
    return _tag(a, label, folder)


# ====================================================================================== bowl outline
class Outline:
    """Rounded rectangle around the pitch, offset outward. Samples share parameters across offsets,
    so consecutive rows can be stitched into strips."""

    def __init__(self, hx, hy, corner, per_m=0.5):
        self.hx, self.hy, self.r = hx, hy, corner
        sx, sy = hx - corner, hy - corner
        self.ns_x = max(4, int(2 * sx * per_m))       # samples along the long straights
        self.ns_y = max(4, int(2 * sy * per_m))
        self.nc = 16                                   # samples per corner
        self.params = []                               # (kind, a, b): straight or corner
        # counter-clockwise from (+x side, -y end)
        for i in range(self.ns_y):                     # east straight (x = +hx), y from -sy to +sy
            self.params.append(("s", (1, 0), (sx, -sy + 2 * sy * i / self.ns_y)))
        for i in range(self.nc):                       # NE corner
            self.params.append(("c", (sx, sy), 0 + 90.0 * i / self.nc))
        for i in range(self.ns_x):                     # north straight (y = +hy), x from +sx to -sx
            self.params.append(("s", (0, 1), (sx - 2 * sx * i / self.ns_x, sy)))
        for i in range(self.nc):
            self.params.append(("c", (-sx, sy), 90.0 + 90.0 * i / self.nc))
        for i in range(self.ns_y):
            self.params.append(("s", (-1, 0), (-sx, sy - 2 * sy * i / self.ns_y)))
        for i in range(self.nc):
            self.params.append(("c", (-sx, -sy), 180.0 + 90.0 * i / self.nc))
        for i in range(self.ns_x):
            self.params.append(("s", (0, -1), (-sx + 2 * sx * i / self.ns_x, -sy)))
        for i in range(self.nc):
            self.params.append(("c", (sx, -sy), 270.0 + 90.0 * i / self.nc))

    def __len__(self):
        return len(self.params)

    def point(self, i, offset):
        """(x, y, nx, ny) in metres for sample i at `offset` beyond the front line."""
        kind, a, b = self.params[i % len(self.params)]
        if kind == "s":
            nx, ny = a
            return (b[0] + nx * (self.r + offset), b[1] + ny * (self.r + offset), nx, ny)
        ang = math.radians(b)
        nx, ny = math.cos(ang), math.sin(ang)
        return (a[0] + nx * (self.r + offset), a[1] + ny * (self.r + offset), nx, ny)

    def ring(self, offset, z):
        return [(p[0] * 100, p[1] * 100, z * 100) for p in (self.point(i, offset) for i in range(len(self)))]


def strip(mesh, slot, A, B, uscale=1.0, flip=False):
    """Quad strip between two rings of equal length (closed loop)."""
    n = len(A)
    along = 0.0
    for i in range(n):
        j = (i + 1) % n
        seg = math.dist(A[i][:2], A[j][:2]) / 100.0
        u0, u1 = along * uscale, (along + seg) * uscale
        along += seg
        uv = ((u0 * 100, 0), (u1 * 100, 0), (u1 * 100, 1), (u0 * 100, 1))
        if flip:
            mesh.quad(slot, A[i], B[i], B[j], A[j], (uv[0], uv[3], uv[2], uv[1]))
        else:
            mesh.quad(slot, A[i], A[j], B[j], B[i], uv)


# ====================================================================================== builders
def build_pitch(cfg, M, meshes_folder):
    f = "Stadium/Pitch"
    L, W = cfg["pitch"]["length"] * 50.0, cfg["pitch"]["width"] * 50.0
    ex, ey = L + cfg["pitch"]["runoffEnd"] * 100, W + cfg["pitch"]["runoffSide"] * 100
    box("Pitch", f, (0, 0, -0.5), ((ex + 50) * 2, (ey + 50) * 2, 1), M["grass"], shadows=False)
    box("Ground", "Stadium/City", (0, 0, -8), (400000, 400000, 10), M["park"], shadows=False)
    for sx in (-1, 1):
        g = "Stadium/Pitch/Goal_%s" % ("West" if sx < 0 else "East")
        x = sx * L
        for sy in (-1, 1):
            cyl("Post", g, (x + sx * 6, sy * 366, 122), 12, 244, M["post"])
        cyl("Crossbar", g, (x + sx * 6, 0, 244), 12, 744, M["post"], R(0, 0, 90))
        depth = 200
        box("NetBack", g, (x + sx * (depth + 6), 0, 110), (2, 732, 220), M["net"], shadows=True)
        box("NetTop", g, (x + sx * (depth / 2 + 6), 0, 238), (depth, 732, 2), M["net"], R(sx * 3.5, 0, 0), shadows=True)
        for sy in (-1, 1):
            box("NetSide", g, (x + sx * (depth / 2 + 6), sy * 366, 120), (depth, 2, 240), M["net"], shadows=True)
            cyl("Stanchion", g, (x + sx * (depth + 6), sy * 366, 110), 5, 220, M["post"])
        cyl("Crossbar_Back", g, (x + sx * (depth + 6), 0, 220), 5, 732, M["post"], R(0, 0, 90))
    for sx in (-1, 1):
        for sy in (-1, 1):
            cyl("CornerFlagPole", "Stadium/Pitch/CornerFlags", (sx * L, sy * W, 75), 3, 150, M["post"])
            box("CornerFlag", "Stadium/Pitch/CornerFlags", (sx * L + sx * 18, sy * W, 135), (36, 1, 26), M["accent"], shadows=False)
    # pitchside LED boards, dugouts
    fb = "Stadium/Boards"
    for s in (-1, 1):
        box("BoardSide", fb, (0, s * (W + 350), 45), (L * 2 * 0.95, 12, 90), M["boards"], shadows=False)
        box("BoardSideFrame", fb, (0, s * (W + 358), 45), (L * 2 * 0.95 + 20, 6, 96), M["steel"])
        box("BoardEnd", fb, (s * (L + 550), 0, 45), (12, W * 2 * 0.9, 90), M["boards"], shadows=False)
        box("Dugout", "Stadium/Dugouts", (s * 1100, -(W + 500), 75), (700, 170, 150), M["white"])
        box("DugoutRoof", "Stadium/Dugouts", (s * 1100, -(W + 470), 152), (720, 230, 8), M["etfe"], shadows=False)
        box("DugoutBench", "Stadium/Dugouts", (s * 1100, -(W + 530), 45), (650, 50, 45), M["seat"])
    note("pitch, goals, boards")


def seat_mesh(folder, M):
    m = Mesh("SM_Seat")
    m.box("Seat", (0, 6, 44), (44, 40, 6))
    m.box("Seat", (0, 24, 68), (44, 5, 40), 0)
    m.box("Seat", (0, 8, 20), (8, 8, 40), 0)
    return m.build(folder, {"Seat": M["seat"]})


def fan_meshes(folder, M):
    """A seated supporter (origin on the tread, facing -Y), arms down and arms up."""
    out = []
    for name, cheer in (("SM_Fan", False), ("SM_FanCheer", True)):
        m = Mesh(name)
        for sx in (-1, 1):
            m.box("Fan", (sx * 9, -40, 25), (11, 11, 50))        # shins
            m.box("Fan", (sx * 9, -20, 52), (14, 42, 14))        # thighs
        m.box("Fan", (0, 0, 54), (36, 22, 16))                    # hips
        m.box("Fan", (0, 2, 75), (34, 21, 28))                    # waist
        m.box("Fan", (0, 2, 98), (42, 23, 22))                    # chest
        m.box("Fan", (0, 2, 111), (11, 10, 6))                    # neck
        m.box("Fan", (0, 0, 125), (17, 20, 23))                   # head
        for sx in (-1, 1):
            if cheer:
                m.box("Fan", (sx * 25, 3, 122), (9, 10, 28))      # upper arm, raised
                m.box("Fan", (sx * 27, 3, 148), (8, 9, 26))       # forearm and hand
            else:
                m.box("Fan", (sx * 24, 3, 95), (10, 11, 28))      # upper arm
                m.box("Fan", (sx * 21, -12, 74), (9, 28, 9))      # forearm on the lap
        out.append(m.build(folder, {"Fan": M["fan"]}))
    return out


def build_bowl(cfg, M, folder, rnd):
    """Tiers as stepped meshes along the outline; seats and fans as instances."""
    P, B = cfg["pitch"], cfg["bowl"]
    hx, hy = P["length"] / 2 + P["runoffEnd"], P["width"] / 2 + P["runoffSide"]
    out = Outline(hx, hy, B["corner"])
    seat = seat_mesh(folder, M)
    fan_mesh, cheer_mesh = fan_meshes(folder, M)
    pans, fans, heads, rails = [], [], [], []   # heads: the cheering fans (arms up)
    stats = {}
    for tier in B["tiers"]:
        mesh = Mesh("SM_Tier_%s" % tier["name"])
        rows, depth, z = tier["rows"], tier["depth"], tier["z"]
        surface = "Crowd" if tier.get("crowdSurface") else "Concrete"
        # front wall (or fascia) from the floor below up to the first tread
        front_floor = 0.0 if tier["front"] == 0 else z - 3.2
        strip(mesh, "Dark", out.ring(tier["front"], front_floor), out.ring(tier["front"], z), flip=True)
        prev = tier["front"]
        h = z
        for r in range(rows):
            u = r / max(1, rows - 1)
            rise = tier["rise"][0] + (tier["rise"][1] - tier["rise"][0]) * u * u
            d0, d1 = prev, prev + depth
            strip(mesh, surface, out.ring(d0, h), out.ring(d1, h))                       # tread
            strip(mesh, surface if surface == "Crowd" else "Concrete", out.ring(d1, h), out.ring(d1, h + rise), flip=True)  # riser
            if tier.get("seats"):
                n = len(out)
                for i in range(n):
                    x0, y0, nx, ny = out.point(i, d0 + depth * 0.45)
                    x1, y1, _, _ = out.point(i + 1, d0 + depth * 0.45)
                    seg = math.hypot(x1 - x0, y1 - y0)
                    k = 0
                    while k * 0.5 < seg:
                        s = k * 0.5 / seg
                        px, py = x0 + (x1 - x0) * s, y0 + (y1 - y0) * s
                        k += 1
                        # radial aisles every ~14 m of the front line
                        if (i % max(1, int(len(out) / 28))) == 0 and k * 0.5 < 1.2:
                            continue
                        yaw = math.degrees(math.atan2(-ny, -nx)) + 90.0   # face the pitch
                        if rnd.random() >= tier.get("fans", 0):
                            pans.append(T((px * 100, py * 100, h * 100), (0, yaw, 0)))
                        else:
                            hgt = rnd.uniform(0.92, 1.08)
                            jit = rnd.uniform(-5, 5)
                            tf = T((px * 100 + jit * ny, py * 100 - jit * nx, h * 100), (0, yaw + rnd.uniform(-12, 12), 0), (hgt * rnd.uniform(0.92, 1.1), hgt, hgt))
                            (heads if rnd.random() < tier.get("cheer", 0.12) else fans).append(tf)
            prev, h = d1, h + rise
        # back of the tier: a soffit down to the next level, and the top edge
        stats[tier["name"]] = {"rows": rows, "top": round(h, 2), "back": round(prev, 2)}
        tier["_back"], tier["_top"] = prev, h
        sm = mesh.build(folder, {"Concrete": M["concrete"], "Dark": M["concreteDark"], "Crowd": M["upperCrowd"] if tier["name"] == "Upper" else M["clubCrowd"]})
        mesh_actor("Tier_%s" % tier["name"], "Stadium/Bowl", sm)
        # fascia LED ribbon on the front of raised tiers
        if tier["front"] > 0:
            rib = Mesh("SM_Ribbon_%s" % tier["name"])
            strip(rib, "LED", out.ring(tier["front"] - 0.05, z - 1.6), out.ring(tier["front"] - 0.05, z - 0.4), uscale=1.0, flip=True)
            mesh_actor("Ribbon_%s" % tier["name"], "Stadium/Bowl", rib.build(folder, {"LED": M["ribbon"]}), shadows=False)
            # underside of the overhang
            soff = Mesh("SM_Soffit_%s" % tier["name"])
            strip(soff, "Dark", out.ring(tier["front"], z - 3.2), out.ring(tier["front"] + 8, z - 3.2), flip=True)
            mesh_actor("Soffit_%s" % tier["name"], "Stadium/Bowl", soff.build(folder, {"Dark": M["concreteDark"]}))
    # suites band
    S = B["suites"]
    su = Mesh("SM_Suites")
    strip(su, "Glass", out.ring(S["front"], S["z"][0]), out.ring(S["front"], S["z"][1]), flip=True)
    strip(su, "Dark", out.ring(S["front"], S["z"][1]), out.ring(S["back"], S["z"][1]))
    mesh_actor("Suites", "Stadium/Bowl", su.build(folder, {"Glass": M["suiteGlass"], "Dark": M["concreteDark"]}))
    # rear wall of the bowl up to the roof
    top = B["tiers"][-1]["_top"]
    bw = Mesh("SM_BackWall")
    strip(bw, "Dark", out.ring(B["back"], top), out.ring(B["back"], cfg["roof"]["zOuter"] + 0.5), flip=True)
    mesh_actor("BackWall", "Stadium/Bowl", bw.build(folder, {"Dark": M["concreteDark"]}))
    # vomitory gaps would go here; rails at the front of each tier
    if pans:
        ism("Seats", "Stadium/Seats", seat, None, pans)
    if fans:
        ism("Fans", "Stadium/Crowd", fan_mesh, None, fans)
    if heads:
        ism("FansCheering", "Stadium/Crowd", cheer_mesh, None, heads)
    note("bowl: %s, %d seats, %d fans (%d cheering)" % (json.dumps(stats), len(pans), len(fans) + len(heads), len(heads)))
    return out


def build_roof(cfg, M, folder, out):
    Rf = cfg["roof"]
    eave, zo, zi = Rf["eave"], Rf["zOuter"], Rf["zInner"]
    n = len(out)
    K = 10   # radial subdivisions
    top = Mesh("SM_Roof")
    if Rf["style"] == "oculus":
        Ro = Rf["oculus"]
        sides = Rf["sides"]

        def inner(i):
            x, y, _, _ = out.point(i, eave)
            ang = math.atan2(y, x)
            # point on the regular polygon (oculus) in the same direction
            a0 = 2 * math.pi / sides
            k = math.floor((ang + math.pi / sides) / a0)
            cen = k * a0
            rr = Ro * math.cos(math.pi / sides) / max(0.3, math.cos(ang - cen))
            return (rr * math.cos(ang), rr * math.sin(ang))
    else:
        def inner(i):
            x, y, nx, ny = out.point(i, Rf["inner"])
            return (x, y)
    rings_top, rings_bot = [], []
    for k in range(K + 1):
        u = k / K
        ringT, ringB = [], []
        for i in range(n):
            x0, y0, _, _ = out.point(i, eave)
            xi, yi = inner(i)
            x, y = x0 + (xi - x0) * u, y0 + (yi - y0) * u
            zt = zo + (zi - zo) * (u ** 0.8) + 1.2 * math.sin(math.pi * u)
            ringT.append((x * 100, y * 100, (zt + 1.2) * 100))
            ringB.append((x * 100, y * 100, zt * 100))
        rings_top.append(ringT)
        rings_bot.append(ringB)
    for k in range(K):
        strip(top, "Top", rings_top[k], rings_top[k + 1], flip=True)
        strip(top, "Under", rings_bot[k], rings_bot[k + 1])
    strip(top, "Edge", rings_bot[K], rings_top[K], flip=True)       # inner edge (oculus rim)
    strip(top, "Edge", rings_bot[0], rings_top[0])                  # eaves
    mesh_actor("Roof", "Stadium/Roof", top.build(folder, {"Top": M["roofTop"], "Under": M["membrane"], "Edge": M["steel"]}))
    # radial trusses and a ring truss under the roof (instanced)
    trusses = []
    step = max(1, n // 96)
    for i in range(0, n, step):
        a, b = rings_bot[0][i], rings_bot[K][i]
        mx, my, mz = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 - 90
        L = math.dist(a[:2], b[:2])
        yaw = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
        pitch = math.degrees(math.atan2(b[2] - a[2], L))
        trusses.append(T((mx, my, mz), (pitch, yaw, 0), (L / 100.0, 0.22, 1.5)))
    for k in (3, 7):
        for i in range(0, n, 2):
            a, b = rings_bot[k][i], rings_bot[k][(i + 2) % n]
            mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
            yaw = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
            trusses.append(T((mx, my, a[2] - 70), (0, yaw, 0), (math.dist(a[:2], b[:2]) / 100.0 + 0.1, 0.3, 1.2)))
    ism("RoofTrusses", "Stadium/Roof", CUBE, M["steel"], trusses, shadows=True)
    # light ring: emissive fixtures along the inner rim, aimed at the pitch
    lamps = []
    for i in range(0, n, 2):
        x, y, z = rings_bot[K - 1][i]
        lamps.append(T((x, y, z - 140), (0, 0, 0), (0.9, 0.9, 0.18)))
    ism("RoofLamps", "Stadium/Roof", CUBE, M["flood"], lamps)
    if Rf["style"] == "oculus":
        build_petals(cfg, M, folder)
        build_halo(cfg, M, folder)
    note("roof: %s, %d trusses" % (Rf["style"], len(trusses)))


def build_petals(cfg, M, folder):
    Rf = cfg["roof"]
    Ro, sides, nP, ap, tw = Rf["oculus"], Rf["sides"], Rf["petals"], Rf["aperture"], math.radians(Rf["twist"])
    z0 = Rf["zInner"] + 2.6
    pm = Mesh("SM_Petals")
    frame = []
    for i in range(nP):
        a0 = 2 * math.pi * i / nP - math.pi / nP
        a1 = a0 + 2 * math.pi / nP
        A = (Ro * 1.04 * math.cos(a0) * 100, Ro * 1.04 * math.sin(a0) * 100, (z0 + 0.05 * i) * 100)
        Bp = (Ro * 1.04 * math.cos(a1) * 100, Ro * 1.04 * math.sin(a1) * 100, (z0 + 0.05 * i) * 100)
        ac = a1 + tw
        Cp = (ap * math.cos(ac) * 100, ap * math.sin(ac) * 100, (z0 + 2.4 + 0.05 * i) * 100)
        pm.tri("ETFE", A, Bp, Cp)      # one side only: the material is two-sided (back-to-back copies weld into zero normals -> NaN glare)
        for p, q in ((A, Cp), (Bp, Cp)):
            L = math.dist(p, q)
            mid = tuple((p[k] + q[k]) / 2 for k in range(3))
            yaw = math.degrees(math.atan2(q[1] - p[1], q[0] - p[0]))
            pitch = math.degrees(math.atan2(q[2] - p[2], math.dist(p[:2], q[:2])))
            frame.append(T(mid, (pitch, yaw, 0), (L / 100.0, 0.7, 0.9)))
    mesh_actor("Petals", "Stadium/Roof/Petals", pm.build(folder, {"ETFE": M["etfe"]}), shadows=False)
    ism("PetalFrames", "Stadium/Roof/Petals", CUBE, M["white"], frame, shadows=True)


def build_halo(cfg, M, folder):
    H = cfg["roof"]["halo"]
    if "halo" not in M:
        return
    r, h, z0 = H["radius"] * 100, H["height"] * 100, H["bottom"] * 100
    seg = 160
    hm = Mesh("SM_Halo")
    for i in range(seg):
        a0, a1 = 2 * math.pi * i / seg, 2 * math.pi * (i + 1) / seg
        p0o, p1o = (r * math.cos(a0), r * math.sin(a0)), (r * math.cos(a1), r * math.sin(a1))
        ri = r - 140
        p0i, p1i = (ri * math.cos(a0), ri * math.sin(a0)), (ri * math.cos(a1), ri * math.sin(a1))
        u0, u1 = i / seg, (i + 1) / seg
        # outer screen (faces the stands), inner screen (faces across the bowl), bottom and top caps
        hm.quad("Screen", (p0o[0], p0o[1], z0), (p1o[0], p1o[1], z0), (p1o[0], p1o[1], z0 + h), (p0o[0], p0o[1], z0 + h), ((u0, 1), (u1, 1), (u1, 0), (u0, 0)))
        hm.quad("Screen", (p1i[0], p1i[1], z0), (p0i[0], p0i[1], z0), (p0i[0], p0i[1], z0 + h), (p1i[0], p1i[1], z0 + h), ((u1, 1), (u0, 1), (u0, 0), (u1, 0)))
        hm.quad("Frame", (p0i[0], p0i[1], z0), (p1i[0], p1i[1], z0), (p1o[0], p1o[1], z0), (p0o[0], p0o[1], z0))
        hm.quad("Frame", (p0o[0], p0o[1], z0 + h), (p1o[0], p1o[1], z0 + h), (p1i[0], p1i[1], z0 + h), (p0i[0], p0i[1], z0 + h))
    mesh_actor("Halo", "Stadium/Halo", hm.build(folder, {"Screen": M["halo"], "Frame": M["steel"]}), shadows=True)
    # hangers up to the roof
    hang = []
    for i in range(16):
        a = 2 * math.pi * i / 16
        top_z = cfg["roof"]["zInner"] * 100
        hang.append(T((r * math.cos(a), r * math.sin(a), (z0 + h + top_z) / 2), (0, 0, 0), (0.12, 0.12, (top_z - z0 - h) / 100.0)))
    ism("HaloHangers", "Stadium/Halo", CYL, M["steel"], hang, shadows=True)


def build_facade(cfg, M, folder, out):
    F = cfg["facade"]
    eave, zo = cfg["roof"]["eave"], cfg["roof"]["zOuter"]
    fm = Mesh("SM_Facade")
    n = len(out)
    # angular panels: the facade leans out at the top, alternating metal and glazing every few samples
    bottom = out.ring(eave - 4.0, 0.0)
    mid = out.ring(eave + 1.0, zo * 0.55)
    topr = out.ring(eave + 0.5, zo + 1.4)
    window = F.get("window")
    for i in range(n):
        j = (i + 1) % n
        x, y, nx, ny = out.point(i, eave)
        big_window = window == "west" and nx < -0.85 or window == "east" and nx > 0.85
        slot_lo = "Glass" if (i // 3) % 2 == 0 or big_window else "Metal"
        slot_hi = "Glass" if big_window else ("Metal" if (i // 5) % 2 == 0 else "Accent" if (i // 5) % 7 == 3 else "Metal")
        along0 = i * 50.0
        uv = ((along0, 0), (along0 + 50, 0), (along0 + 50, 1), (along0, 1))
        fm.quad(slot_lo, bottom[i], bottom[j], mid[j], mid[i], uv)
        fm.quad(slot_hi, mid[i], mid[j], topr[j], topr[i], uv)
    mesh_actor("Facade", "Stadium/Facade", fm.build(folder, {"Glass": M["facadeGlass"], "Metal": M["panel"], "Accent": M["accent"]}))
    # mullions / fins
    fins = []
    for i in range(0, n, 3):
        a, b = out.point(i, eave - 4.0), out.point(i, eave + 1.0)
        yaw = math.degrees(math.atan2(a[3], a[2]))
        fins.append(T(((a[0] + b[0]) * 50, (a[1] + b[1]) * 50, zo * 55 / 2 * 1.0), (0, yaw, -6), (0.35, 0.15, zo * 0.55)))
    ism("FacadeFins", "Stadium/Facade", CUBE, M["steel"], fins, shadows=True)
    # plaza ring and approach roads
    pl = Mesh("SM_Plaza")
    strip(pl, "Plaza", out.ring(eave - 4.0, 0.03), out.ring(eave + 40.0, 0.03))
    mesh_actor("Plaza", "Stadium/City", pl.build(folder, {"Plaza": M["plaza"]}), shadows=False)
    note("facade + plaza")


def build_city(cfg, M, rnd):
    blds, trees, roads = [], [], []
    for k in range(260):
        ang = rnd.uniform(0, 2 * math.pi)
        dist = rnd.uniform(26000, 90000)
        x, y = dist * math.cos(ang), dist * math.sin(ang)
        w, d = rnd.uniform(2500, 6000), rnd.uniform(2500, 6000)
        h = rnd.uniform(1500, 6000) * (1.8 if dist > 50000 and rnd.random() < 0.3 else 1.0)
        blds.append(T((x, y, h / 2), (0, rnd.uniform(0, 90), 0), (w / 100, d / 100, h / 100)))
    for k in range(500):
        ang = rnd.uniform(0, 2 * math.pi)
        dist = rnd.uniform(17500, 24000)
        s = rnd.uniform(5, 9)
        trees.append(T((dist * math.cos(ang), dist * math.sin(ang), s * 50), (0, 0, 0), (s * 0.6, s * 0.6, s)))
    for a in range(4):
        yaw = a * 45.0
        roads.append(T((0, 0, -2), (0, yaw, 0), (2400, 18, 0.05)))
    ism("Buildings", "Stadium/City", CUBE, M["building"], blds, shadows=True)
    ism("Trees", "Stadium/City", LOWSPHERE, M["park"], trees)
    ism("Roads", "Stadium/City", CUBE, M["asphalt"], roads)
    note("city: %d buildings" % len(blds))


def build_lighting(cfg):
    f = "Stadium/Lighting"
    s = cfg["sun"]
    sun = ACT.spawn_actor_from_class(unreal.DirectionalLight, V(0, 0, 10000), R(-s["elevation"], s["azimuth"], 0))
    _tag(sun, "Sun", f)
    lc = sun.light_component
    for k, v in (("intensity", s["intensity"]), ("use_temperature", True), ("temperature", float(s["temperature"])),
                 ("atmosphere_sun_light", True), ("cast_shadows", True), ("light_source_angle", 0.6), ("dynamic_shadow_distance_movable_light", 30000.0)):
        try:
            lc.set_editor_property(k, v)
        except Exception:
            pass
    sky = ACT.spawn_actor_from_class(unreal.SkyAtmosphere, V(), R())
    _tag(sky, "SkyAtmosphere", f)
    sl = ACT.spawn_actor_from_class(unreal.SkyLight, V(0, 0, 3000), R())
    _tag(sl, "SkyLight", f)
    try:
        sl.light_component.set_editor_property("real_time_capture", True)
        sl.light_component.set_editor_property("intensity", 1.3)
    except Exception:
        pass
    fog = ACT.spawn_actor_from_class(unreal.ExponentialHeightFog, V(0, 0, -2000), R())
    _tag(fog, "HeightFog", f)
    try:
        fc = fog.component
        fc.set_editor_property("fog_density", 0.0012)
        fc.set_editor_property("fog_height_falloff", 0.25)
        fc.set_editor_property("volumetric_fog", False)
    except Exception:
        pass
    # bowl fill: soft rect lights from the roof rim aimed at the pitch (no shadows: cheap, even)
    # hung below the halo (nothing within ~25 m of the emitters, or they blow out nearby surfaces)
    zi = (cfg["roof"]["halo"]["bottom"] - 3.0) * 100 if cfg["roof"]["style"] == "oculus" else cfg["roof"]["zInner"] * 100 - 600
    for k in range(8):
        a = 2 * math.pi * (k + 0.5) / 8
        r = (cfg["roof"]["oculus"] - 3) * 100 if cfg["roof"]["style"] == "oculus" else 6500
        loc = V(r * math.cos(a), r * math.sin(a) * 0.8, zi)
        rot = unreal.MathLibrary.find_look_at_rotation(loc, V(r * math.cos(a) * 0.25, r * math.sin(a) * 0.2, 0))
        rl = ACT.spawn_actor_from_class(unreal.RectLight, loc, rot)
        _tag(rl, "BowlLight_%d" % k, f)
        try:
            c = rl.light_component
            c.set_editor_property("intensity_units", unreal.LightUnits.CANDELAS)
            c.set_editor_property("intensity", float(cfg.get("lights", {}).get("bowl", 5000.0)))
            c.set_editor_property("source_width", 900.0)
            c.set_editor_property("source_height", 300.0)
            c.set_editor_property("attenuation_radius", 15000.0)
            c.set_editor_property("cast_shadows", False)
            c.set_editor_property("temperature", 5600.0)
            c.set_editor_property("use_temperature", True)
        except Exception:
            pass
    pp = ACT.spawn_actor_from_class(unreal.PostProcessVolume, V(), R())
    _tag(pp, "PostProcess", f)
    pp.set_editor_property("unbound", True)
    st = pp.get_editor_property("settings")
    for k, v in (("bloom_intensity", 0.28), ("vignette_intensity", 0.3), ("auto_exposure_bias", 0.4), ("auto_exposure_min_brightness", 0.5),
                 ("auto_exposure_max_brightness", 3.0), ("film_grain_intensity", 0.06), ("scene_fringe_intensity", 0.15),
                 ("lumen_final_gather_quality", 2.0), ("lumen_scene_detail", 1.5), ("lumen_reflection_quality", 1.5),
                 ("color_saturation", unreal.Vector4(1.04, 1.04, 1.04, 1.0)), ("color_contrast", unreal.Vector4(1.06, 1.06, 1.06, 1.0))):
        try:
            st.set_editor_property("override_" + k, True)
            st.set_editor_property(k, v)
        except Exception:
            pass
    pp.set_editor_property("settings", st)
    note("lighting: sun %.0f deg, sky, fog, %d bowl lights" % (s["elevation"], 8))


# ====================================================================================== halo texture
FONT = {  # 5x7 bitmap font
    "A": "01110100011000111111100011000110001", "B": "11110100011000111110100011000111110", "C": "01110100011000010000100001000101110",
    "D": "11110100011000110001100011000111110", "E": "11111100001000011110100001000011111", "F": "11111100001000011110100001000010000",
    "G": "01110100011000010111100011000101111", "H": "10001100011000111111100011000110001", "I": "01110001000010000100001000010001110",
    "K": "10001100101010011000101001001010001", "L": "10000100001000010000100001000011111", "M": "10001110111010110101100011000110001",
    "N": "10001110011010110011100011000110001", "O": "01110100011000110001100011000101110", "P": "11110100011000111110100001000010000",
    "R": "11110100011000111110101001001010001", "S": "01111100001000001110000010000111110", "T": "11111001000010000100001000010000100",
    "U": "10001100011000110001100011000101110", "V": "10001100011000110001100010101000100", "W": "10001100011000110101101011101110001",
    "Y": "10001100010101000100001000010000100", "0": "01110100011001110101110011000101110", "1": "00100011000010000100001000010001110",
    "2": "01110100010000100010001000100011111", "!": "00100001000010000100001000000000100", " ": "0" * 35, "-": "00000000000000011111000000000000000",
    ".": "00000000000000000000000000110001100",
}


def _png(path, w, h, pixels):
    raw = b"".join(b"\x00" + bytes(pixels[y * w * 3:(y + 1) * w * 3]) for y in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def halo_texture(cfg, folder, saved_dir):
    """A 2048x128 strip: team colour panels, MATCHDAY, team names; imported as a texture."""
    W_, H_ = 2048, 128
    C = cfg["colors"]
    hx = lambda c: tuple(int(c.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4))
    home, away = hx(C["home"]), hx(C["away"])
    px = bytearray(W_ * H_ * 3)

    def rect(x0, y0, x1, y1, col):
        for y in range(max(0, y0), min(H_, y1)):
            for x in range(max(0, x0), min(W_, x1)):
                i = (y * W_ + x) * 3
                px[i:i + 3] = bytes(col)

    def text(s, x, y, scale, col):
        for ch in s:
            g = FONT.get(ch, FONT[" "])
            for r in range(7):
                for c in range(5):
                    if g[r * 5 + c] == "1":
                        rect(x + c * scale, y + r * scale, x + (c + 1) * scale, y + (r + 1) * scale, col)
            x += 6 * scale
        return x

    rect(0, 0, W_, H_, (8, 9, 12))
    panels = [("MATCHDAY", home, (255, 255, 255)), (cfg.get("homeName", "REDS"), home, (255, 255, 255)), ("V", (20, 22, 28), (255, 255, 255)),
              (cfg.get("awayName", "WHITES"), away, (20, 30, 70) if sum(away) > 500 else (255, 255, 255)), ("LIVE", (20, 22, 28), (255, 60, 60))]
    x = 0
    pw = W_ // len(panels)
    for label, bg, fg in panels:
        rect(x + 6, 10, x + pw - 6, H_ - 10, bg)
        for k in range(0, pw - 12, 18):   # diagonal sheen
            rect(x + 6 + k, 10, x + 6 + k + 4, H_ - 10, tuple(min(255, int(c * 1.12)) for c in bg))
        scale = 9
        tw = len(label) * 6 * scale
        if tw > pw - 30:
            scale = max(4, int((pw - 30) / (len(label) * 6)))
            tw = len(label) * 6 * scale
        text(label, x + (pw - tw) // 2, (H_ - 7 * scale) // 2, scale, fg)
        x += pw
    os.makedirs(saved_dir, exist_ok=True)
    png = os.path.join(saved_dir, "T_HaloStrip.png")
    _png(png, W_, H_, px)
    task = unreal.AssetImportTask()
    task.set_editor_property("filename", png)
    task.set_editor_property("destination_path", folder)
    task.set_editor_property("destination_name", "T_HaloStrip")
    task.set_editor_property("replace_existing", True)
    task.set_editor_property("automated", True)
    task.set_editor_property("save", True)
    AT.import_asset_tasks([task])
    tex = EAL.load_asset(folder + "/T_HaloStrip")
    return tex


# ====================================================================================== main
def build(job):
    t0 = time.time()
    preset = job.get("preset", "oculus")
    cfg = merge(PRESETS[preset], job.get("config") or {})
    cfg["homeName"], cfg["awayName"] = job.get("homeName", "REDS"), job.get("awayName", "WHITES")
    folder = job.get("assetDir", "/Game/HFilm/Stadium")
    meshes = folder + "/Meshes"
    rnd = random.Random(job.get("seed", 7))
    world = unreal.EditorLoadingAndSavingUtils.new_blank_map(False) if job.get("newMap", True) else None
    clear_level()
    tex = halo_texture(cfg, folder, job.get("savedDir", os.path.join(unreal.Paths.project_saved_dir(), "HFilm", "Stadium"))) if cfg["roof"]["style"] == "oculus" else None
    M = build_materials(cfg, folder, tex)
    build_pitch(cfg, M, meshes)
    out = build_bowl(cfg, M, meshes, rnd)
    build_roof(cfg, M, meshes, out)
    build_facade(cfg, M, meshes, out)
    if cfg.get("city"):
        build_city(cfg, M, rnd)
    build_lighting(cfg)
    saved = False
    if job.get("map"):
        w = world or unreal.EditorLevelLibrary.get_editor_world()
        saved = unreal.EditorLoadingAndSavingUtils.save_map(w, job["map"])
    res = {"ok": bool(saved) or not job.get("map"), "map": job.get("map"), "preset": preset, "seconds": round(time.time() - t0, 1), "log": LOG,
           "folders": {"hide": [], "holdouts": ["Stadium/Pitch/Goal_West", "Stadium/Pitch/Goal_East", "Stadium/Pitch/CornerFlags", "Stadium/Boards", "Stadium/Dugouts"],
                       "meshHoldouts": ["Stadium/Roof", "Stadium/Halo", "Stadium/Bowl", "Stadium/Facade"], "grid": "M_Net", "ground": "Pitch"}}
    return res


if __name__ == "__main__":
    path = os.environ.get("HFILM_STADIUM_JOB")
    if path:
        job = json.load(open(path))
        try:
            res = build(job)
        except Exception:
            import traceback
            res = {"ok": False, "error": traceback.format_exc(), "log": LOG}
        json.dump(res, open(job.get("result", path + ".result.json"), "w"), indent=1)
        print("HFILM_STADIUM", json.dumps({k: res[k] for k in res if k != "log"}))
