@echo off
rem There is one Photoshop plugin now (com.waveplug.studio): it runs G:\waveplug\studio\dist\plugin
rem when that folder is reachable, so development needs no separate plugin. This installs the
rem newest release .ccx (as administrator, Photoshop closed), same as install_ccx.cmd.
call "%~dp0install_ccx.cmd" %*
