/*
 * Copyright (c) 2017 - present Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */
 
/**
 * Manages Editor navigation history to aid back/fwd movement between the edit positions 
 * in the active project context. The navigation history is purely in-memory and not 
 * persisted to file system when a project is being closed.
 */
define(function (require, exports, module) {
    "use strict";

    var Strings                 = brackets.getModule("strings"),
        MainViewManager         = brackets.getModule("view/MainViewManager"),
        DocumentManager         = brackets.getModule("document/DocumentManager"),
        DocumentCommandHandlers = brackets.getModule("document/DocumentCommandHandlers"),
        EditorManager           = brackets.getModule("editor/EditorManager"),
        Editor                  = brackets.getModule("editor/Editor"),
        ProjectManager          = brackets.getModule("project/ProjectManager"),
        CommandManager          = brackets.getModule("command/CommandManager"),
        Commands                = brackets.getModule("command/Commands"),
        Menus                   = brackets.getModule("command/Menus"),
        KeyBindingManager       = brackets.getModule("command/KeyBindingManager"),
        FileSystem              = brackets.getModule("filesystem/FileSystem");

    var KeyboardPrefs = JSON.parse(require("text!keyboard.json"));
    
    // Command constants for navigation history
    var NAVIGATION_JUMP_BACK      = "navigation.jump.back",
        NAVIGATION_JUMP_FWD       = "navigation.jump.fwd";
    
    // The latency time to capture an explicit cursor movement as a navigation frame
    var NAV_FRAME_CAPTURE_LATENCY = 2000;
    
    /*
    * Contains list of most recently known cursor positions.
    * @private
    * @type {Array.<Object>}
    */
    var jumpToPosStack = [];
    
    /*
    * Contains list of most recently traversed cursor positions using NAVIGATION_JUMP_BACK command.
    * @private
    * @type {Array.<Object>}
    */
    var jumpedPosStack = [],
        captureTimer,
        activePosNotSynched = false,
        jumpInProgress,
        command_JumpBack,
        command_JumpFwd,
        cmMarkers = {};
     
   /**
    * Function to enable/disable navigation command based on cursor positions availability.
    * @private
    */
    function _validateNavigationCmds() {
        if (jumpToPosStack.length > 0) {
            command_JumpBack.setEnabled(true);
        } else {
            command_JumpBack.setEnabled(false);
        }
        
        if (jumpedPosStack.length > 0) {
            command_JumpFwd.setEnabled(true);
        } else {
            command_JumpFwd.setEnabled(false);
        }
    }
    
    /**
    * Function to check existence of a file entry
    * @private
    */
    function _checkIfExist(entry) {
        var deferred = new $.Deferred(),
            fileEntry = FileSystem.getFileForPath(entry.file);

        if (entry.inMem) {
            var indxInWS = MainViewManager.findInWorkingSet(entry.paneId, entry.file);
            // Remove entry if InMemoryFile is not found in Working set
            if (indxInWS === -1) {
                deferred.reject();
            } else {
                deferred.resolve();
            }
        } else {
            fileEntry.exists(function (err, exists) {
                if (!err && exists) {
                    deferred.resolve();
                } else {
                    deferred.reject();
                }
		    });
	    }

        return deferred.promise();
    }
        
   /**
    * Prototype to capture a navigation frame and it's various data/functional attributues
    */
    function NavigationFrame(editor, selectionObj) {
        this.cm = editor._codeMirror;
        this.file = editor.document.file._path;
        this.inMem = editor.document.file.constructor.name === "InMemoryFile" ? true : false;
        this.paneId = editor._paneId;
        this.uId = (new Date()).getTime();
        this.selections = [];
        this.bookMarkIds = [];
        this._createMarkers(selectionObj.ranges);
        this._bindEditor(editor);
    }
    
   /**
    * Binds the lifecycle event listner of the editor for which this frame is captured
    */
    NavigationFrame.prototype._bindEditor = function (editor) {
        var self = this;
        editor.on("beforeDestroy", function () {
            self._backupSelectionRanges();
            self.cm = null;
            self.bookMarkIds = null;
        });
    };
    
   /**
    * Function to create CM TextMarkers for the navigated positions/selections.
    * This logic is required to ensure that the captured navaigation positions 
    * stay valid and contextual even when the actual document text mutates.
    * The mutations which are handled here :
    * -> Addition/Deletion of lines before the captured position
    * -> Addition/Updation of characters in the captured selection
    */
    NavigationFrame.prototype._createMarkers = function (ranges) {
        var range, index, bookMark;
        this.bookMarkIds = [];
        for (index in ranges) {
            range = ranges[index];
            // 'markText' has to used for a non-zero length position, if current selection is 
            // of zero length use bookmark instead.
            if (range.anchor.line === range.head.line && range.anchor.ch === range.head.ch) {
                bookMark = this.cm.setBookmark(range.anchor, range.head);
                this.bookMarkIds.push(bookMark.id);
            } else {
                this.cm.markText(range.anchor, range.head, {className: (this.uId)});
            }
        }
    };
    
   /**
    * Function to actually convert the CM markers to CM positions which can be used to 
    * set selections or cursor positions in Editor.
    */
    NavigationFrame.prototype._backupSelectionRanges = function () {
        if (!this.cm) {
            return;
        }
        
        this.selections = [];
        var marker, selection, index;
        var self = this;
        var markers = this.cm.getAllMarks().filter(function (entry) {
            if (entry.className === self.uId || self.bookMarkIds.indexOf(entry.id) !== -1) {
                return entry;
            }
        });
        for (index in markers) {
            marker = markers[index];
            selection = marker.find();
            if (marker.type === "bookmark") {
                this.selections.push({start: selection, end: selection});
            } else {
                this.selections.push({start: selection.from, end: selection.to});
            }
        }
    };

   /**
    * Function to actually navigate to the position(file,selections) captured in this frame
    */
    NavigationFrame.prototype.goTo = function () {
        var self = this;
        this._backupSelectionRanges();
        jumpInProgress = true;
        CommandManager.execute(Commands.FILE_OPEN, {fullPath: this.file, paneId: this.paneId}).done(function () {
            EditorManager.getCurrentFullEditor().setSelections(self.selections, true);
            _validateNavigationCmds();
        }).always(function () {
            jumpInProgress = false;
        });
    };
    
    
   /**
    * Function to capture a non-zero set of selections as a navigation frame.
    * The assumptions behind capturing a frame as a navigation frame are :
    *
    * -> If it's set by user explicitly (using mouse click or jump to definition)
    * -> By clicking on search results
    * -> Change of cursor by keyboard navigation keys or actual edits are not captured.
    *
    * @private
    */
    function _recordJumpDef(event, selectionObj) {
        if (jumpInProgress) {
            return;
        }
        // Reset forward navigation stack if we are capturing a new event
        jumpedPosStack = [];
        if (captureTimer) {
            window.clearTimeout(captureTimer);
            captureTimer = null;
        }
        // Ensure cursor activity has not happened because of arrow keys or edit
        if (selectionObj.origin !== "+move" && (window.event && window.event.type !== "input")) {
            captureTimer = window.setTimeout(function () {
                jumpToPosStack.push(new NavigationFrame(event.target, selectionObj));
                _validateNavigationCmds();
                activePosNotSynched = false;
            }, NAV_FRAME_CAPTURE_LATENCY);
        } else {
            activePosNotSynched = true;
        }
    }
    
   /**
    * Command handler to navigate backward
    */
    function _navigateBack() {
        if (!jumpedPosStack.length) {
            if (activePosNotSynched) {
                jumpToPosStack.push(new NavigationFrame(EditorManager.getCurrentFullEditor(), {ranges: EditorManager.getCurrentFullEditor()._codeMirror.listSelections()}));
            }
        }
        var navFrame = jumpToPosStack.pop();
        if (navFrame) {
            // We will check for the file existence now, if it doesn't exist we will jump back again
            // but discard the popped frame as invalid.
            _checkIfExist(navFrame).done(function () {
                jumpedPosStack.push(navFrame);
                navFrame.goTo();
            }).fail(function () {
                _validateNavigationCmds();
                CommandManager.execute(NAVIGATION_JUMP_BACK);
            });
        }
    }
    
   /**
    * Command handler to navigate forward
    */
    function _navigateFwd() {
        var navFrame = jumpedPosStack.pop();
        if (navFrame) {
            // We will check for the file existence now, if it doesn't exist we will jump back again
            // but discard the popped frame as invalid.
            _checkIfExist(navFrame).done(function () {
                jumpToPosStack.push(navFrame);
                navFrame.goTo();
            }).fail(function () {
                _validateNavigationCmds();
                CommandManager.execute(NAVIGATION_JUMP_FWD);
            });
        }
    }
    
    /**
    * Function to initialize navigation menu items.
    * @private
    */
    function _initNavigationMenuItems() {
        var menu = Menus.getMenu(Menus.AppMenuBar.NAVIGATE_MENU);
        menu.addMenuItem(NAVIGATION_JUMP_BACK, "", Menus.AFTER, Commands.NAVIGATE_PREV_DOC);
        menu.addMenuItem(NAVIGATION_JUMP_FWD, "", Menus.AFTER, NAVIGATION_JUMP_BACK);
    }
    
   /**
    * Function to initialize navigation commands and it's keyboard shortcuts.
    * @private
    */
    function _initNavigationCommands() {
        CommandManager.register(Strings.CMD_NAVIGATE_BACKWARD, NAVIGATION_JUMP_BACK, _navigateBack);
        CommandManager.register(Strings.CMD_NAVIGATE_FORWARD, NAVIGATION_JUMP_FWD, _navigateFwd);
        command_JumpBack = CommandManager.get(NAVIGATION_JUMP_BACK);
        command_JumpFwd = CommandManager.get(NAVIGATION_JUMP_FWD);
        command_JumpBack.setEnabled(false);
        command_JumpFwd.setEnabled(false);
        KeyBindingManager.addBinding(NAVIGATION_JUMP_BACK, KeyboardPrefs[NAVIGATION_JUMP_BACK]);
        KeyBindingManager.addBinding(NAVIGATION_JUMP_FWD, KeyboardPrefs[NAVIGATION_JUMP_FWD]);
        _initNavigationMenuItems();
    }
    
   /**
    * Function to request a navigation frame creation explicitly.
    * @private
    */
    function _captureFrame(editor) {
        // Capture the active position now if it was not captured earlier
        if ((activePosNotSynched || !jumpToPosStack.length) && !jumpInProgress) {
            jumpToPosStack.push(new NavigationFrame(editor, {ranges: editor._codeMirror.listSelections()}));
        }
    }
    
    /**
     * Handle Active Editor change to update navigation information
     * @private
     */
    function _handleActiveEditorChange(event, current, previous) {
        if (previous && previous._paneId) { // Handle only full editors
            previous.off("beforeSelectionChange", _recordJumpDef);
            _captureFrame(previous);
            _validateNavigationCmds();
        }
        
        if (current && current._paneId) { // Handle only full editors
            activePosNotSynched = true;
            current.on("beforeSelectionChange", _recordJumpDef);
        }
    }
    
    function _handleProjectOpen() {
        jumpToPosStack = [];
        jumpedPosStack = [];
    }
    
    function _initHandlers() {
        EditorManager.on("activeEditorChange", _handleActiveEditorChange);
        ProjectManager.on("projectOpen", _handleProjectOpen);
    }

    function init() {
        _initNavigationCommands();
        _initHandlers();
    }
    
    exports.init = init;
});
