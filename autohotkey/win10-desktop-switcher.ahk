; Globals
DesktopCount = 2 ; Windows starts with 2 desktops at boot
CurrentDesktop = 1 ; Desktop count is 1-indexed (Microsoft numbers them this way)
;
; This function examines the registry to build an accurate list of the current virtual desktops and which one we're currently on.
; Current desktop UUID appears to be in HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\SessionInfo\1\VirtualDesktops
; List of desktops appears to be in HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops
;
mapDesktopsFromRegistry() {
 global CurrentDesktop, DesktopCount
 ; Get the current desktop UUID. Length should be 32 always, but there's no guarantee this couldn't change in a later Windows release so we check.
 IdLength := 32
 SessionId := getSessionId()
 if (SessionId) {
 RegRead, CurrentDesktopId, HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\SessionInfo\%SessionId%\VirtualDesktops, CurrentVirtualDesktop
 if (CurrentDesktopId) {
 IdLength := StrLen(CurrentDesktopId)
 }
 }
 ; Get a list of the UUIDs for all virtual desktops on the system
 RegRead, DesktopList, HKEY_CURRENT_USER, SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops, VirtualDesktopIDs
 if (DesktopList) {
 DesktopListLength := StrLen(DesktopList)
 ; Figure out how many virtual desktops there are
 DesktopCount := DesktopListLength / IdLength
 }
 else {
 DesktopCount := 1
 }
 ; Parse the REG_DATA string that stores the array of UUID's for virtual desktops in the registry.
 i := 0
 while (CurrentDesktopId and i < DesktopCount) {
 StartPos := (i * IdLength) + 1
 DesktopIter := SubStr(DesktopList, StartPos, IdLength)
 OutputDebug, The iterator is pointing at %DesktopIter% and count is %i%.
 ; Break out if we find a match in the list. If we didn't find anything, keep the
 ; old guess and pray we're still correct :-D.
 if (DesktopIter = CurrentDesktopId) {
 CurrentDesktop := i + 1
 OutputDebug, Current desktop number is %CurrentDesktop% with an ID of %DesktopIter%.
 break
 }
 i++
 }
}
;
; This functions finds out ID of current session.
;
getSessionId()
{
 ProcessId := DllCall("GetCurrentProcessId", "UInt")
 if ErrorLevel {
 OutputDebug, Error getting current process id: %ErrorLevel%
 return
 }
 OutputDebug, Current Process Id: %ProcessId%
 DllCall("ProcessIdToSessionId", "UInt", ProcessId, "UInt*", SessionId)
 if ErrorLevel {
 OutputDebug, Error getting session id: %ErrorLevel%
 return
 }
 OutputDebug, Current Session Id: %SessionId%
 return SessionId
}
;
; This function switches to the desktop number provided.
;
switchDesktopByNumber(targetDesktop)
{
 global CurrentDesktop, DesktopCount
 ; Re-generate the list of desktops and where we fit in that. We do this because
 ; the user may have switched desktops via some other means than the script.
 mapDesktopsFromRegistry()
 ; Don't attempt to switch to an invalid desktop
 if (targetDesktop > DesktopCount || targetDesktop < 1) {
 OutputDebug, [invalid] target: %targetDesktop% current: %CurrentDesktop%
 return
 }
 ; Go right until we reach the desktop we want
 while(CurrentDesktop < targetDesktop) {
 Send ^#{Right}
 CurrentDesktop++
 OutputDebug, [right] target: %targetDesktop% current: %CurrentDesktop%
 }
 ; Go left until we reach the desktop we want
 while(CurrentDesktop > targetDesktop) {
 Send ^#{Left}
 CurrentDesktop--
 OutputDebug, [left] target: %targetDesktop% current: %CurrentDesktop%
 }
}
;
; This function creates a new virtual desktop and switches to it
;
createVirtualDesktop()
{
 global CurrentDesktop, DesktopCount
 Send, #^d
 DesktopCount++
 CurrentDesktop = %DesktopCount%
 OutputDebug, [create] desktops: %DesktopCount% current: %CurrentDesktop%
}
;
; This function deletes the current virtual desktop
;
deleteVirtualDesktop()
{
 global CurrentDesktop, DesktopCount
 Send, #^{F4}
 DesktopCount--
 CurrentDesktop--
 OutputDebug, [delete] desktops: %DesktopCount% current: %CurrentDesktop%
}
; Main
SetKeyDelay, 75
mapDesktopsFromRegistry()
OutputDebug, [loading] desktops: %DesktopCount% current: %CurrentDesktop%
; User config!
; This section binds the key combo to the switch/create/delete actions
LALT & 1::switchDesktopByNumber(1)
LALT & 2::
    If(GetKeyState("Shift", "D"))
        Send, {F1}
    ELSE
        switchDesktopByNumber(2)   
return
LALT & 3::switchDesktopByNumber(3)
;win10也要开启PrtSc截图按键的功能
LALT & 4::
    If(GetKeyState("Shift", "D"))
        ;打开截图的同时，会打开浏览器，并输入法失灵
        ;Send, {LWin down}{Shift down}s{LWin up}{Shift up}

        Send, {PrintScreen}
    ELSE
        switchDesktopByNumber(4)   
return
LALT & 5::
    If(GetKeyState("Shift", "D"))
        Send, {F1}
    ELSE
        switchDesktopByNumber(5)   
return
LALT & 6::switchDesktopByNumber(6)
LALT & 7::switchDesktopByNumber(7)
LALT & 8::switchDesktopByNumber(8)
LALT & 9::switchDesktopByNumber(9)

;ahk_exe, 获取当前活跃的ahk_exe, 并打印
;F2::
;    WinGetClass, class, A  ; 获取当前活动窗口的类名
;    MsgBox, Current Active Window ahk_class:%class%  ; 显示类名
;
;    SetTitleMatchMode, 2 
;    ;activeWindow := WinGetActiveTitle() 
;    WinGetActiveTitle, activeWindow
;    MsgBox, Current Active Window title:%activeWindow%
;return

; 检查是否有 Windows 10 默认输入法的中文候选词窗口
CheckCandidateWindow() {
    candidateClasses := ["IPTip_Main_Window", "Afx:00400000"]  ; 添加其他类名
    Loop, % candidateClasses.MaxIndex() {
        className := candidateClasses[A_Index]
        If WinExist("ahk_class " className) {
            return true  ; 找到候选词窗口
        }
    }
    return false  ; 未找到候选词窗口
}

F2::
    tempFile := A_Temp "\CandidateStatus.txt"  ; 临时文件路径
    if CheckCandidateWindow() {
        FileAppend, 中文候选词窗口已打开。`n, %tempFile%
    } else {
        FileAppend, 中文候选词窗口未打开。`n, %tempFile%
    }

    Run, notepad.exe %tempFile%
return




;!为ALT
!d::
    Send, {LWin down}s{LWin up}  ; 模拟按下 Win + S
return

!f::
    WinGet, activeId, ID, A  ; 获取当前活动窗口的ID
    WinGet, state, MinMax, ahk_id %activeId%  ; 获取窗口的最小化/最大化状态

    if (state = 1) {  ; 如果窗口处于最大化状态
        WinRestore, ahk_id %activeId%  ; 恢复窗口
    } else {
        WinMaximize, ahk_id %activeId%  ; 最大化窗口
    }
return





;LWin & 1::switchDesktopByNumber(1)
;LWin & 2::switchDesktopByNumber(2)
;LWin & 3::switchDesktopByNumber(3)
;LWin & 4::switchDesktopByNumber(4)
;LWin & 5::switchDesktopByNumber(5)
;LWin & 6::switchDesktopByNumber(6)
;LWin & 7::switchDesktopByNumber(7)
;LWin & 8::switchDesktopByNumber(8)
;LWin & 9::switchDesktopByNumber(9)
;CapsLock & 1::switchDesktopByNumber(1)
;CapsLock & 2::switchDesktopByNumber(2)
;CapsLock & 3::switchDesktopByNumber(3)
;CapsLock & 4::switchDesktopByNumber(4)
;CapsLock & 5::switchDesktopByNumber(5)
;CapsLock & 6::switchDesktopByNumber(6)
;CapsLock & 7::switchDesktopByNumber(7)
;CapsLock & 8::switchDesktopByNumber(8)
;CapsLock & 9::switchDesktopByNumber(9)
;CapsLock & n::switchDesktopByNumber(CurrentDesktop + 1)
;CapsLock & p::switchDesktopByNumber(CurrentDesktop - 1)
;CapsLock & s::switchDesktopByNumber(CurrentDesktop + 1)
;CapsLock & a::switchDesktopByNumber(CurrentDesktop - 1)
;CapsLock & c::createVirtualDesktop()
;CapsLock & d::deleteVirtualDesktop()
; Alternate keys for this config. Adding these because DragonFly (python) doesn't send CapsLock correctly.
;^!1::switchDesktopByNumber(1)
;^!2::switchDesktopByNumber(2)
;^!3::switchDesktopByNumber(3)
;^!4::switchDesktopByNumber(4)
;^!5::switchDesktopByNumber(5)
;^!6::switchDesktopByNumber(6)
;^!7::switchDesktopByNumber(7)
;^!8::switchDesktopByNumber(8)
;^!9::switchDesktopByNumber(9)
;^!n::switchDesktopByNumber(CurrentDesktop + 1)
;^!p::switchDesktopByNumber(CurrentDesktop - 1)
;^!s::switchDesktopByNumber(CurrentDesktop + 1)
;^!a::switchDesktopByNumber(CurrentDesktop - 1)
;^!c::createVirtualDesktop()
;^!d::deleteVirtualDesktop()