@echo off
REM Fallback: render all 4 shots in the background (fills only missing frames).
REM Usage: render_final.bat "C:\Program Files\Blender Foundation\Blender 4.x\blender.exe"
set BLENDER=%~1
if "%BLENDER%"=="" set BLENDER=blender
set EP=%~dp0..\episodes\ai_disappeared
for %%R in ("1 72" "73 144" "145 216" "217 288") do (
  for /f "tokens=1,2" %%a in (%%R) do "%BLENDER%" -b "%EP%\episode.blend" -s %%a -e %%b -a
)
echo Done. Now run: python "%~dp0assemble_video.py"
