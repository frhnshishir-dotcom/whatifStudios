"""
WhatIfStudio EP001 v6 - look_v6.py : cinematic look development on the v5 scene.
Look only: no geometry, cameras or animation changed. Edits shared node families in place.
 1. Sky: physical sky + procedural cloud layer (cheap; world shader), so glass reflects something real.
 2. Atmospheric perspective: every material's haze switches from linear-from-380 m to a smooth
    exponential ramp from ~60 m, coloured to match the horizon -> foreground crisp, skyline soft.
 3. Light + material response: no flat fill, warmer/stronger low sun, softer shadow edge, better AO;
    glass tints neutralised, per-pane roughness/reflectance variation on all facade families.
Writes master_city_v6.blend.
"""
import bpy, math
from pathlib import Path
ROOT = Path(globals()["__file__"]).resolve().parent.parent.parent
OUT = ROOT / "master_city_v6.blend"
sc = bpy.data.scenes["EP001_City_v2"]; TAG = "whatif_v2"
def sock(ss, ident): return next(s for s in ss if s.identifier == ident or s.name == ident)
log = {}

# ------------------------------------------------------------- 1. sky with clouds
w = sc.world.node_tree; N, L = w.nodes, w.links.new
sky = next(n for n in N if n.type == "TEX_SKY")
bg_sky = next(n for n in N if n.type == "BACKGROUND" and n.inputs["Color"].is_linked and n.inputs["Color"].links[0].from_node == sky)
for n in [n for n in N if n.get("v6")]: N.remove(n)
def node(t, **kw):
    n = N.new(t); n["v6"] = 1
    for k, v in kw.items(): setattr(n, k, v)
    return n
tc = node("ShaderNodeTexCoord"); sep = node("ShaderNodeSeparateXYZ"); L(tc.outputs["Generated"], sep.inputs[0])
zc = node("ShaderNodeMath", operation="MAXIMUM"); L(sep.outputs["Z"], zc.inputs[0]); zc.inputs[1].default_value = 0.02
px = node("ShaderNodeMath", operation="DIVIDE"); L(sep.outputs["X"], px.inputs[0]); L(zc.outputs[0], px.inputs[1])
py = node("ShaderNodeMath", operation="DIVIDE"); L(sep.outputs["Y"], py.inputs[0]); L(zc.outputs[0], py.inputs[1])
pl = node("ShaderNodeCombineXYZ"); L(px.outputs[0], pl.inputs[0]); L(py.outputs[0], pl.inputs[1])
nz = node("ShaderNodeTexNoise"); nz.inputs["Scale"].default_value = 0.9; nz.inputs["Detail"].default_value = 7.0
nz.inputs["Roughness"].default_value = 0.6; nz.inputs["Distortion"].default_value = 0.35; L(pl.outputs[0], nz.inputs["Vector"])
ramp = node("ShaderNodeValToRGB"); L(nz.outputs["Fac"], ramp.inputs["Fac"])
ramp.color_ramp.elements[0].position, ramp.color_ramp.elements[0].color = 0.50, (0, 0, 0, 1)
ramp.color_ramp.elements[1].position, ramp.color_ramp.elements[1].color = 0.70, (1, 1, 1, 1)
fade = node("ShaderNodeMapRange", clamp=True); L(sep.outputs["Z"], fade.inputs["Value"])
fade.inputs["From Min"].default_value, fade.inputs["From Max"].default_value = 0.03, 0.22
cover = node("ShaderNodeMath", operation="MULTIPLY"); L(ramp.outputs["Color"], cover.inputs[0]); L(fade.outputs["Result"], cover.inputs[1])
cover2 = node("ShaderNodeMath", operation="MULTIPLY"); L(cover.outputs[0], cover2.inputs[0]); cover2.inputs[1].default_value = 0.85
shade = node("ShaderNodeMapRange", clamp=True); L(nz.outputs["Fac"], shade.inputs["Value"])          # lit tops / greyer bases
shade.inputs["From Min"].default_value, shade.inputs["From Max"].default_value = 0.55, 0.85
shade.inputs["To Min"].default_value, shade.inputs["To Max"].default_value = 1.15, 2.1
gain = node("ShaderNodeVectorMath", operation="SCALE"); L(sky.outputs["Color"], gain.inputs[0]); L(shade.outputs["Result"], gain.inputs["Scale"])
warm = node("ShaderNodeMix", data_type="RGBA", blend_type="MULTIPLY"); sock(warm.inputs, "Factor_Float").default_value = 1.0
L(gain.outputs[0], sock(warm.inputs, "A_Color")); sock(warm.inputs, "B_Color").default_value = (1.0, 0.94, 0.88, 1)
mixc = node("ShaderNodeMix", data_type="RGBA"); L(cover2.outputs[0], sock(mixc.inputs, "Factor_Float"))
L(sky.outputs["Color"], sock(mixc.inputs, "A_Color")); L(sock(warm.outputs, "Result_Color"), sock(mixc.inputs, "B_Color"))
L(sock(mixc.outputs, "Result_Color"), bg_sky.inputs["Color"])
bg_sky.inputs["Strength"].default_value = 0.10
log["sky"] = "clouds added (projected noise, horizon fade, lit/grey variation)"

# ------------------------------------------------------------- 2. atmospheric perspective (all materials)
n_haze = 0
for m in bpy.data.materials:
    if not (m.node_tree and m.users): continue
    for n in m.node_tree.nodes:
        if n.type == "MAP_RANGE" and n.inputs["Value"].is_linked and n.inputs["Value"].links[0].from_node.type == "CAMERA":
            n.interpolation_type = "SMOOTHERSTEP"
            n.inputs["From Min"].default_value, n.inputs["From Max"].default_value = 60.0, 1700.0
            n.inputs["To Min"].default_value, n.inputs["To Max"].default_value = 0.0, 0.62
            n_haze += 1
log["haze_nodes"] = n_haze

# ------------------------------------------------------------- 3a. glass response on all facade families
def desat(c, k):
    l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    return tuple(l + (x - l) * k for x in c[:3]) + (1.0,)
n_glass = 0
for m in bpy.data.materials:
    nt = m.node_tree
    if not (nt and m.users and "CityPower" in nt.nodes) or nt.get("v6"): continue
    b = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if b is None or not b.inputs["Base Color"].is_linked: continue
    base_mix = b.inputs["Base Color"].links[0].from_node
    noise = next((n for n in nt.nodes if n.type == "TEX_WHITE_NOISE"), None)
    if noise is None: continue
    r = noise.outputs["Value"]
    for n in nt.nodes:                                              # neutralise pane tints (keep slight hue)
        if n.type == "MIX" and getattr(n, "data_type", "") == "RGBA":
            f = sock(n.inputs, "Factor_Float")
            if f.is_linked and f.links[0].from_node == noise:
                for k in ("A_Color", "B_Color"):
                    s = sock(n.inputs, k)
                    if not s.is_linked: s.default_value = desat(s.default_value, 0.45)
    wf = sock(base_mix.inputs, "Factor_Float") if base_mix.type == "MIX" else None
    win = wf.links[0].from_socket if (wf is not None and wf.is_linked) else None
    if win is not None and b.inputs["Roughness"].is_linked:
        src = b.inputs["Roughness"].links[0].from_socket
        a1 = nt.nodes.new("ShaderNodeMath"); a1.operation = "MULTIPLY"; nt.links.new(win, a1.inputs[0]); nt.links.new(r, a1.inputs[1])
        a2 = nt.nodes.new("ShaderNodeMath"); a2.operation = "MULTIPLY_ADD"; nt.links.new(a1.outputs[0], a2.inputs[0]); a2.inputs[1].default_value = 0.09
        nt.links.new(src, a2.inputs[2]); nt.links.new(a2.outputs[0], b.inputs["Roughness"])         # panes 0.03-0.12: distortion variety
    nt["v6"] = 1; n_glass += 1
log["facade_families_tuned"] = n_glass
for nm, col in (("MAT_Window_Glass_v3", None),):
    m = bpy.data.materials.get(nm)
    if m: m.node_tree.nodes["Principled BSDF"].inputs["Specular IOR Level"].default_value = 0.6

# ------------------------------------------------------------- 3b. light, shadows, AO, exposure
sun = sc.objects["LIGHT_Sun_Main"]
sun.data.energy = 5.4; sun.data.color = (1.0, 0.80, 0.62); sun.data.angle = math.radians(1.6)
sc.objects["LIGHT_Fill_Sky"].data.energy = 0.0
ee = sc.eevee
ee.use_fast_gi = True; ee.fast_gi_method = "GLOBAL_ILLUMINATION"; ee.fast_gi_distance = 14.0; ee.fast_gi_quality = 0.45
ee.ray_tracing_options.trace_max_roughness = 0.45
vs = sc.view_settings; vs.view_transform = "AgX"; vs.look = "AgX - Medium High Contrast"; vs.exposure = -0.1
log["light"] = "sun 5.4 / 1.6 deg, fill off, AO dist 14 q .45, exposure -0.1"
bpy.data.libraries.write(str(OUT), {sc}, path_remap="ABSOLUTE", compress=True)
result = {"log": log, "saved": str(OUT)}

# ---------------- PASS 2 (after inspecting pass-1 renders): horizon band + clouds
HZ = (0.66, 0.67, 0.71, 1.0)            # haze = horizon sky brightness -> distant city fades lighter, no grey wall
for m in bpy.data.materials:
    if not (m.node_tree and m.users): continue
    for nd in m.node_tree.nodes:
        if nd.type == "EMISSION" and nd.outputs[0].is_linked and nd.outputs[0].links[0].to_node.type == "MIX_SHADER":
            f = nd.outputs[0].links[0].to_node.inputs[0]
            if f.is_linked and f.links[0].from_node.type == "MAP_RANGE": nd.inputs["Color"].default_value = HZ
hb = next(x for x in N if x.type == "BACKGROUND" and not x.inputs["Color"].is_linked); hb.inputs["Color"].default_value = HZ
mr = next(x for x in N if x.type == "MAP_RANGE" and not x.get("v6")); mr.inputs["From Min"].default_value, mr.inputs["From Max"].default_value = -0.01, 0.10
ramp.color_ramp.elements[0].position = 0.43; ramp.color_ramp.elements[1].position = 0.64
bw = node("ShaderNodeRGBToBW"); L(sky.outputs["Color"], bw.inputs[0]); grey = node("ShaderNodeCombineXYZ")
for i in range(3): L(bw.outputs[0], grey.inputs[i])
L(grey.outputs[0], gain.inputs[0]); shade.inputs["To Min"].default_value, shade.inputs["To Max"].default_value = 1.3, 2.6
cover2.inputs[1].default_value = 0.95
bpy.data.libraries.write(str(OUT), {sc}, path_remap="ABSOLUTE", compress=True)
