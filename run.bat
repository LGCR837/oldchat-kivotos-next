@echo off
echo ¨q©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤¨r
echo ©¦                                                              ©¦
echo ©¦              OldChat For Kivotos Next (OCKN)                 ©¦
echo ©¦              Powered by Aoharu Reverie (LGCR837)             ©¦
echo ©¦                                                              ©¦
echo ¨t©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤¨s
echo      -- https://github.com/LGCR837/oldchat-kivotos-next --
echo.
cd /d "%~dp0"
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /c:"IPv4"') do (
    set "ip=%%i"
    goto :ipfound
)
:ipfound
set "ip=%ip: =%"
taskkill /f /fi "imagename eq nginx.exe" /fi "cwd eq \"%CD%\"" 2>nul
if not exist logs mkdir logs
if not exist temp mkdir temp
echo     Running on Port 5520
echo       ¡ñ http://localhost:5520/
echo       ¡ñ http://127.0.0.1:5520/
if defined ip echo       ¡ñ http://%ip%:5520/
nginx.exe -g "daemon off; error_log stderr;"
pause