@echo off
cd /d "%~dp0.."
git pull --recurse-submodules
pause
