"""PowerPoint motion: slide transitions (incl. Morph) and auto-playing entrance builds, written as
OOXML because python-pptx has no API for them.

Morph: PowerPoint matches objects across two slides by name when the names start with '!!'.
The builder names paired shapes '!!<key>' (e.g. '!!title'), so a hero title on the opening slide glides
into place as the next slide's title, Apple-keynote style. Morph needs PowerPoint 2019 / Microsoft 365;
older versions and LibreOffice show the Fade fallback.

Entrances: one auto-starting group after the transition, effects staggered by delay:
  fade -> PowerPoint 'Fade'      (presetID 10)
  rise -> PowerPoint 'Float In'  (presetID 42, fade + 10 % upward drift)
"""
from __future__ import annotations

from lxml import etree

NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
NS_MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
NS_P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"
NS_P159 = "http://schemas.microsoft.com/office/powerpoint/2015/09/main"

_SIMPLE = {
    "fade": "<p:fade/>",
    "push": '<p:push dir="u"/>',
    "wipe": '<p:wipe dir="r"/>',
    "zoom": '<p:zoom/>',
    "rise": "<p:fade/>",
    "cut": "<p:cut/>",
    "iris": "<p:circle/>",
    "shutter": '<p:split orient="horz" dir="out"/>',
    "blur": "<p:fade/>",
}
# PowerPoint 2010+ transitions (p14) with a Fade fallback for older viewers / LibreOffice
_P14 = {
    "flip": '<p14:flip dir="r"/>',
    "cube": '<p14:prism isContent="1"/>',
    "vortex": '<p14:vortex dir="r"/>',
    "zoom": "<p14:flythrough/>",
    "gallery": '<p14:gallery dir="l"/>',
    "ripple": "<p14:ripple/>",
}


def _spd(ms: int) -> str:
    return "slow" if ms >= 850 else ("med" if ms >= 550 else "fast")


def _clear(sld):
    for tag in (f"{{{NS_P}}}transition", f"{{{NS_MC}}}AlternateContent", f"{{{NS_P}}}timing"):
        for e in sld.findall(tag):
            sld.remove(e)


def _insert_after_clrmap(sld, el):
    anchor = sld.find(f"{{{NS_P}}}clrMapOvr")
    if anchor is None:
        anchor = sld.find(f"{{{NS_P}}}cSld")
    anchor.addnext(el)


def transition_xml(kind: str, ms: int) -> etree._Element:
    if kind == "morph":
        xml = (
            f'<mc:AlternateContent xmlns:mc="{NS_MC}" xmlns:p="{NS_P}">'
            f'<mc:Choice xmlns:p159="{NS_P159}" Requires="p159">'
            f'<p:transition xmlns:p14="{NS_P14}" spd="slow" p14:dur="{int(ms)}"><p159:morph option="byObject"/></p:transition>'
            f"</mc:Choice><mc:Fallback><p:transition spd=\"slow\"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>"
        )
    elif kind in _P14:
        xml = (
            f'<mc:AlternateContent xmlns:mc="{NS_MC}" xmlns:p="{NS_P}">'
            f'<mc:Choice xmlns:p14="{NS_P14}" Requires="p14">'
            f'<p:transition spd="slow" p14:dur="{int(ms * 1.3)}">{_P14[kind]}</p:transition>'
            f"</mc:Choice><mc:Fallback><p:transition spd=\"slow\">{_SIMPLE.get(kind, '<p:fade/>')}</p:transition></mc:Fallback></mc:AlternateContent>"
        )
    else:
        inner = _SIMPLE.get(kind, "<p:fade/>")
        xml = f'<p:transition xmlns:p="{NS_P}" spd="{_spd(ms)}">{inner}</p:transition>'
    return etree.fromstring(xml)


def _effect(cid: int, spid: int, delay: int, dur: int, kind: str, first: bool) -> tuple[str, int]:
    node = "afterEffect" if first else "withEffect"
    tgt = f'<p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl>'
    ids = iter(range(cid + 1, cid + 10))
    beh = (
        f'<p:set><p:cBhvr><p:cTn id="{next(ids)}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>{tgt}'
        f'<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>'
        f'<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="{next(ids)}" dur="{dur}"/>{tgt}</p:cBhvr></p:animEffect>'
    )
    preset = 10
    if kind == "rise":
        preset = 42
        for attr, frm in (("ppt_x", "#ppt_x"), ("ppt_y", "#ppt_y+.1")):
            to = "#ppt_x" if attr == "ppt_x" else "#ppt_y"
            beh += (
                f'<p:anim calcmode="lin" valueType="num"><p:cBhvr><p:cTn id="{next(ids)}" dur="{dur}" decel="100000" fill="hold"/>{tgt}'
                f'<p:attrNameLst><p:attrName>{attr}</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst>'
                f'<p:tav tm="0"><p:val><p:strVal val="{frm}"/></p:val></p:tav>'
                f'<p:tav tm="100000"><p:val><p:strVal val="{to}"/></p:val></p:tav></p:tavLst></p:anim>'
            )
    used = next(ids)
    xml = (
        f'<p:par><p:cTn id="{cid}" presetID="{preset}" presetClass="entr" presetSubtype="0" fill="hold" grpId="0" nodeType="{node}">'
        f'<p:stCondLst><p:cond delay="{int(delay)}"/></p:stCondLst><p:childTnLst>{beh}</p:childTnLst></p:cTn></p:par>'
    )
    return xml, used


def apply(slide, transition: str | None, trans_ms: int, effects: list[tuple[int, int, str, str]], dur_ms: int):
    """effects: (shape_id, delay_ms, kind, element_tag) — kind fade|rise, element_tag sp|pic|graphicFrame|cxnSp."""
    sld = slide._element
    _clear(sld)
    if transition and transition != "none":
        _insert_after_clrmap(sld, transition_xml(transition, trans_ms))
    if not effects:
        return
    effects = list(effects)
    parts, cid, media = [], 5, []
    for i, (spid, delay, kind, _tag) in enumerate(effects):
        if kind == "media":  # embedded video: start automatically with the slide
            node = "afterEffect" if i == 0 else "withEffect"
            parts.append(
                f'<p:par><p:cTn id="{cid}" presetID="1" presetClass="mediacall" presetSubtype="0" fill="hold" nodeType="{node}">'
                f'<p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:cmd type="call" cmd="playFrom(0.0)">'
                f'<p:cBhvr><p:cTn id="{cid + 1}" dur="{int(delay)}" fill="hold"/><p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl></p:cBhvr></p:cmd>'
                f"</p:childTnLst></p:cTn></p:par>")
            media.append(spid)
            cid += 2
            continue
        xml, cid = _effect(cid, spid, delay, dur_ms, kind, i == 0)
        parts.append(xml)
    video_nodes = "".join(
        f'<p:video><p:cMediaNode vol="80000" mute="1"><p:cTn id="{cid + k}" repeatCount="indefinite" fill="hold" display="0">'
        f'<p:stCondLst><p:cond delay="indefinite"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl></p:cMediaNode></p:video>'
        for k, spid in enumerate(media))
    effects = [e for e in effects if e[2] != "media"]
    bld = []
    for spid, _d, _k, tag in effects:
        if tag == "sp":
            bld.append(f'<p:bldP spid="{spid}" grpId="0" animBg="1"/>')
        elif tag == "graphicFrame":
            bld.append(f'<p:bldGraphic spid="{spid}" grpId="0"><p:bldAsOne/></p:bldGraphic>')
    timing = (
        f'<p:timing xmlns:p="{NS_P}"><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>'
        f'<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>'
        f'<p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond></p:stCondLst><p:childTnLst>'
        f'<p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>'
        + "".join(parts)
        + "</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>"
        "</p:childTnLst></p:cTn>"
        '<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>'
        '<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>'
        "</p:seq>" + video_nodes + "</p:childTnLst></p:cTn></p:par></p:tnLst>"
        + (f"<p:bldLst>{''.join(bld)}</p:bldLst>" if bld else "")
        + "</p:timing>"
    )
    el = etree.fromstring(timing)
    # timing goes after transition (or clrMapOvr) — schema order: cSld, clrMapOvr, transition, timing, extLst
    last = None
    for tag in (f"{{{NS_MC}}}AlternateContent", f"{{{NS_P}}}transition", f"{{{NS_P}}}clrMapOvr", f"{{{NS_P}}}cSld"):
        last = sld.find(tag)
        if last is not None:
            break
    last.addnext(el)
