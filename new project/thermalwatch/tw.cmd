@echo off
REM Windows convenience wrapper: tw demo  ==  python tw.py demo
where py >nul 2>nul && (py -3 "%~dp0tw.py" %*) || (python "%~dp0tw.py" %*)
