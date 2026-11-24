"""Assemble the 30-second concept film from its parts (modular: swap any segment and re-run).

  python projects/revolut-nigeria/scripts/assemble_campaign.py [--vo path/to/voiceover_lines.json] [--out name]

Timeline (matches the brief's storyboard; 0.4 s cross-transitions are absorbed inside the segments):
  0-5   opener (motion graphics on the graded Lagos photo)
  5-11  entrepreneur (AI shot, or the clearly labelled placeholder)
  11-17.6 professional (AI shot at 0.94x: 6.59 s -> 7.0 s incl. transition; imperceptible)
  17.6-24 student (AI shot at 0.97x: 6.59 s -> 6.8 s incl. transition)
  (the professional/student cut sits 0.4 s before the brief's 18 s so neither shot needs visible slow motion)
  24-27 conceptual interface reveal (motion graphics)
  27-30 end frame (motion graphics)
Audio: original synthesized music bed + SFX, plus the voiceover lines if provided, ducked and loudness-normalised.
"""
import argparse
import json
import shutil
import subprocess
from pathlib import Path

P = Path(__file__).resolve().parents[1]
STUDIO = P.parents[1]
EXP = STUDIO / "exports" / "revolut-nigeria" / "video"
FONTS = STUDIO / "assets" / "fonts"
FF = shutil.which("ffmpeg")
W, H, FPS = 1920, 1080, 30

# (file, segment length incl. outgoing transition, speed factor, transition into NEXT segment)
LINES = {
    "entrepreneur": ("THE ENTREPRENEUR", "For the people building something of their own."),
    "professional": ("THE PROFESSIONAL", "For the people moving towards something bigger."),
    "student": ("THE STUDENT", "For the people whose ambitions go beyond borders."),
}
VO_AT = [0.55, 5.65, 11.6, 18.05, 24.1]  # voiceover line starts (s); each line ends inside its own section


def textfile(name, s):
    p = EXP / "_txt" / f"{name}.txt"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(s, encoding="utf-8")
    return str(p).replace(":", r"\:")


def supers(key, dur):
    label, line = LINES[key]
    lab, txt = textfile(f"{key}_label", label), textfile(f"{key}_line", line)
    tag = textfile("ai_tag", "AI-GENERATED FOOTAGE · PROPOSED CONCEPT — NOT AN OFFICIAL REVOLUT AD")
    mono, disp = str(FONTS / "IBMPlexMono-Medium.ttf"), str(FONTS / "SpaceGrotesk-SemiBold.ttf")
    a0, a1 = 0.55, dur - 0.75
    alpha = f"if(lt(t\\,{a0})\\,0\\,if(lt(t\\,{a0 + 0.45})\\,(t-{a0})/0.45\\,if(lt(t\\,{a1})\\,1\\,max(0\\,1-(t-{a1})/0.35))))"
    return (f"drawtext=fontfile='{mono}':textfile='{lab}':fontsize=24:fontcolor=0x8FB0FF:x=110:y=h-218:alpha='{alpha}',"
            f"drawtext=fontfile='{disp}':textfile='{txt}':fontsize=54:fontcolor=white:x=108:y=h-178:alpha='{alpha}',"
            f"drawtext=fontfile='{mono}':textfile='{tag}':fontsize=18:fontcolor=white@0.55:x=w-tw-60:y=48")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vo", help="JSON with a list of 5 voiceover line files (mp3/wav), in order")
    ap.add_argument("--entrepreneur", default=str(P / "assets/video/ai_shot_entrepreneur.mp4"))
    ap.add_argument("--out", default="REVOLUT_NIGERIA_CAMPAIGN_30SEC")
    a = ap.parse_args()
    EXP.mkdir(parents=True, exist_ok=True)
    ent = Path(a.entrepreneur)
    ent_is_ai = ent.exists()
    if not ent_is_ai:
        ent = EXP / "seg_entrepreneur_placeholder.mp4"
    segs = [
        (EXP / "seg_opener.mp4", 5.4, 1.0, None, "smoothleft"),
        (ent, 6.4, 1.0, "entrepreneur" if ent_is_ai else None, "smoothleft"),
        (P / "assets/video/ai_shot_professional.mp4", 7.0, 7.0 / 6.59, "professional", "smoothleft"),
        (P / "assets/video/ai_shot_student.mp4", 6.8, 6.8 / 6.59, "student", "circleopen"),
        (EXP / "seg_reveal.mp4", 3.4, 1.0, None, "fade"),
        (EXP / "seg_endcard.mp4", 3.0, 1.0, None, None, 0.35),  # start 0.35 s in: title already rising at the cut
    ]
    grad = EXP / "_txt" / "bottom_grad.png"
    grad.parent.mkdir(parents=True, exist_ok=True)
    if not grad.exists():
        import numpy as np
        from PIL import Image
        y = np.linspace(0, 1, H)[:, None]
        al = (np.clip((y - 0.55) / 0.45, 0, 1) ** 1.5 * 200).astype("uint8")
        rgba = np.zeros((H, W, 4), "uint8")
        rgba[..., 3] = np.repeat(al, W, 1)
        Image.fromarray(rgba, "RGBA").save(grad)

    inputs, chains = [], []
    for i, (f, dur, speed, key, _tr, *rest) in enumerate(segs):
        skip = rest[0] if rest else 0.0
        inputs += ["-i", str(f)]
        c = (f"[{i}:v]setpts=PTS*{speed:.5f},fps={FPS},scale={W}:{H}:force_original_aspect_ratio=increase:flags=lanczos,"
             f"crop={W}:{H},trim={skip}:{skip + dur},setpts=PTS-STARTPTS,format=yuv420p")
        if key:
            gi = len(segs) + 0  # gradient input index added below
            c += f"[b{i}];[b{i}][g{i}]overlay=0:0,{supers(key, dur)},format=yuv420p"
        chains.append((c, key))
    filt = []
    gin = len(segs)
    inputs += ["-loop", "1", "-i", str(grad)]
    n_ai = sum(1 for _, k in chains if k)
    if n_ai:
        filt.append(f"[{gin}:v]format=rgba,split={n_ai}" + "".join(f"[g{i}]" for i, (_, k) in enumerate(chains) if k))
    for i, (c, _k) in enumerate(chains):
        filt.append(f"{c}[v{i}]")
    # xfade chain
    off = 0.0
    prev = "v0"
    for i in range(1, len(segs)):
        off += segs[i - 1][1] - 0.4
        tr = segs[i - 1][4]
        out = f"x{i}"
        filt.append(f"[{prev}][v{i}]xfade=transition={tr}:duration=0.4:offset={off:.3f}[{out}]")
        prev = out
    filt.append(f"[{prev}]trim=0:30,setpts=PTS-STARTPTS[vout]")

    # audio
    ai = gin + 1
    inputs += ["-i", str(P / "assets/audio/music_bed.wav"), "-i", str(P / "assets/audio/sfx.wav")]
    mus, sfx = ai, ai + 1
    vo_files = json.loads(Path(a.vo).read_text()) if a.vo else []
    if vo_files:
        for k, vf in enumerate(vo_files):
            inputs += ["-i", vf]
        vo_idx = list(range(ai + 2, ai + 2 + len(vo_files)))
        for k, idx in enumerate(vo_idx):
            ms = int(VO_AT[k] * 1000)
            filt.append(f"[{idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay={ms}|{ms},volume=1.0[vo{k}]")
        filt.append("".join(f"[vo{k}]" for k in range(len(vo_idx))) + f"amix=inputs={len(vo_idx)}:normalize=0,apad=whole_dur=30[vo]")
        filt.append("[vo]asplit=2[vo_a][vo_sc]")
        filt.append(f"[{mus}:a]volume=0.55[m]")
        filt.append("[m][vo_sc]sidechaincompress=threshold=0.04:ratio=6:attack=15:release=350[mduck]")
        filt.append(f"[mduck][{sfx}:a]amix=inputs=2:normalize=0[bed]")
        filt.append("[bed][vo_a]amix=inputs=2:normalize=0,atrim=0:30,loudnorm=I=-16:TP=-1.5:LRA=11[aout]")
    else:
        filt.append(f"[{mus}:a]volume=0.8[m];[m][{sfx}:a]amix=inputs=2:normalize=0,atrim=0:30,loudnorm=I=-16:TP=-1.5:LRA=11[aout]")

    script = EXP / "_txt" / "filter.txt"
    script.write_text(";\n".join(filt))
    out = EXP / f"{a.out}.mp4"
    cmd = [FF, "-y", "-v", "error"] + inputs + ["-filter_complex_script", str(script), "-map", "[vout]", "-map", "[aout]",
           "-c:v", "libx264", "-preset", "slow", "-crf", "19", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", str(FPS),
           "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", "30", "-movflags", "+faststart", str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        print(r.stderr[-3000:])
        raise SystemExit(1)
    probe = subprocess.run([FF.replace("ffmpeg", "ffprobe"), "-v", "error", "-count_frames", "-show_entries",
                            "stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_frames,sample_rate:format=duration",
                            "-of", "json", str(out)], capture_output=True, text=True).stdout
    info = json.loads(probe)
    print(json.dumps(info, indent=1))
    print(("AI entrepreneur shot" if ent_is_ai else "PLACEHOLDER entrepreneur segment"), "| VO lines:", len(vo_files))
    print("wrote", out)


if __name__ == "__main__":
    main()
