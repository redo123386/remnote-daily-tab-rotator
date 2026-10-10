@echo off
REM Builds Daily Tab Rotator for upload to RemNote and makes a clean copy of the code for GitHub.
title Prepare Daily Tab Rotator for upload
cd /d "%~dp0"
echo.
echo  1) Create an empty PUBLIC repository on github.com first (e.g. remnote-daily-tab-rotator).
echo  2) Paste its link below.
echo.
set /p REPO=GitHub repository link:
if "%REPO%"=="" (echo No link entered. & pause & exit /b 1)
node -e "const fs=require('fs');const f='public/manifest.json';const m=JSON.parse(fs.readFileSync(f,'utf8'));m.repoUrl=process.argv[1].trim().replace(/\.git$/,'').replace(/\/$/,'');m.unlisted=true;m.requestNative=true;fs.writeFileSync(f,JSON.stringify(m,null,2)+'\n');console.log('manifest: repoUrl='+m.repoUrl+', unlisted, requests Native mode')" "%REPO%"
if errorlevel 1 (echo Could not update manifest.json. & pause & exit /b 1)
if not exist node_modules\webpack\bin\webpack.js (
  echo.
  echo The build tools are missing. Run start.bat first, close it once it says "compiled successfully", then run this again.
  pause
  exit /b 1
)
echo.
echo Building (takes up to a minute)...
if exist dist rmdir /s /q dist
if exist PluginZip.zip del /q PluginZip.zip
set NODE_ENV=production
node node_modules\webpack\bin\webpack.js --color
if not exist dist\manifest.json (
  echo.
  echo BUILD FAILED - the "dist" folder was not created. Copy all the text in this window and send it to Claude.
  pause
  exit /b 1
)
if not exist dist\index.js (
  echo.
  echo BUILD FAILED - dist\index.js is missing. Copy all the text in this window and send it to Claude.
  pause
  exit /b 1
)
echo.
echo Zipping...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path 'dist\*' -DestinationPath 'PluginZip.zip' -Force"
if not exist PluginZip.zip (
  echo.
  echo ZIP FAILED - PluginZip.zip was not created. Copy all the text in this window and send it to Claude.
  pause
  exit /b 1
)
echo.
echo Making a clean copy of the code for GitHub (without node_modules)...
if exist github-upload rmdir /s /q github-upload
robocopy . github-upload /E /XD node_modules dist github-upload .git /XF PluginZip.zip *.zip /NFL /NDL /NJH /NJS /NP >nul
echo.
echo ============================================================
echo  Done - PluginZip.zip is ready.
echo  - Upload the CONTENTS of the "github-upload" folder to your GitHub repo
echo  - Then in RemNote: Settings - Plugins - Build - Upload plugin - PluginZip.zip
echo ============================================================
explorer /select,"%~dp0PluginZip.zip"
pause
