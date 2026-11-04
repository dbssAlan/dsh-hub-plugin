@echo off
rem Windows wrapper for the standalone hub CLI.
rem Usage: dsh-hub.cmd [--port 19388] [--no-tunnel] [--target 43825]
node "%~dp0lib\hub-cli.mjs" %*
