/* -*- Mode: js2; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */

/* GdkWindow and GtkWindow are totally different things. A GtkWindow is a
 "standalone" window. A GdkWindow is just a region on the screen that can
 capture events and has certain attributes (such as a cursor, and a coordinate
 system). Basically a GdkWindow is an X window, in the Xlib sense, and
 GtkWindow is a widget used for a particular UI effect.
 (http://mail.gnome.org/archives/gtk-app-devel-list/1999-January/msg00138.html) */

var EXPORTED_SYMBOLS = [ "firetray" ];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/ctypes.jsm");
Cu.import("resource://firetray/ctypesMap.jsm");
Cu.import("resource://firetray/gobject.jsm");
Cu.import("resource://firetray/gdk.jsm");
Cu.import("resource://firetray/gtk.jsm");
Cu.import("resource://firetray/libc.jsm");
Cu.import("resource://firetray/x11.jsm");
Cu.import("resource://firetray/commons.js");

const Services2 = {};
XPCOMUtils.defineLazyServiceGetter(
  Services2,
  "uuid",
  "@mozilla.org/uuid-generator;1",
  "nsIUUIDGenerator"
);

if ("undefined" == typeof(firetray.Handler))
  ERROR("This module MUST be imported from/after FiretrayHandler !");

/**
 * custum type used to pass data in to and out of findGtkWindowByTitleCb
 */
var _find_data_t = ctypes.StructType("_find_data_t", [
  { inTitle: ctypes.char.ptr },
  { outWindow: gtk.GtkWindow.ptr }
]);


firetray.Window = {

  /**
   * Iterate over all Gtk toplevel windows to find a window. We rely on
   * Service.wm to watch windows correctly: we should find only one window.
   *
   * @author Nils Maier (stolen from MiniTrayR)
   * @param window nsIDOMWindow from Services.wm
   * @return a gtk.GtkWindow.ptr
   */
  getGtkWindowHandle: function(window) {
    let baseWindow = window
          .QueryInterface(Ci.nsIInterfaceRequestor)
          .getInterface(Ci.nsIWebNavigation)
          .QueryInterface(Ci.nsIBaseWindow);

    // Tag the base window
    let oldTitle = baseWindow.title;
    LOG("oldTitle="+oldTitle);
    baseWindow.title = Services2.uuid.generateUUID().toString();

    try {
      // Search the window by the *temporary* title
      let widgets = gtk.gtk_window_list_toplevels();
      let that = this;
      let findGtkWindowByTitleCb = gobject.GFunc_t(that._findGtkWindowByTitle);
      var userData = new _find_data_t(
        ctypes.char.array()(baseWindow.title),
        null
      ).address();
      LOG("userData="+userData);
      gobject.g_list_foreach(widgets, findGtkWindowByTitleCb, userData);
      gobject.g_list_free(widgets);

      if (userData.contents.outWindow.isNull()) {
        throw new Error("Window not found!");
      }
      LOG("found window: "+userData.contents.outWindow);
    } catch (x) {
      ERROR(x);
    } finally {
      // Restore
      baseWindow.title = oldTitle;
    }

    return userData.contents.outWindow;
  },

  /**
   * compares a GtkWindow's title with a string passed in userData
   * @param gtkWidget: GtkWidget from gtk_window_list_toplevels()
   * @param userData: _find_data_t
   */
  _findGtkWindowByTitle: function(gtkWidget, userData) {
    // LOG("GTK Window: "+gtkWidget+", "+userData);

    let data = ctypes.cast(userData, _find_data_t.ptr);
    let inTitle = data.contents.inTitle;
    // LOG("inTitle="+inTitle.readString());

    let gtkWin = ctypes.cast(gtkWidget, gtk.GtkWindow.ptr);
    let winTitle = gtk.gtk_window_get_title(gtkWin);

    if (!winTitle.isNull()) {
      LOG(inTitle+" = "+winTitle);
      if (libc.strcmp(inTitle, winTitle) == 0)
        data.contents.outWindow = gtkWin;
    }
  },

  getGdkWindowFromGtkWindow: function(gtkWin) {
    try {
      let gtkWid = ctypes.cast(gtkWin, gtk.GtkWidget.ptr);
      return gtk.gtk_widget_get_window(gtkWid);
    } catch (x) {
      ERROR(x);
    }
    return null;
  },

  getXIDFromGdkWindow: function(gdkWin) {
    return gdk.gdk_x11_drawable_get_xid(ctypes.cast(gdkWin, gdk.GdkDrawable.ptr));
  },

  getXIDFromGtkWidget: function(gtkWid) {
    try {
      let gdkWin = gtk.gtk_widget_get_window(gtkWid);
      return gdk.gdk_x11_drawable_get_xid(ctypes.cast(gdkWin, gdk.GdkDrawable.ptr));
    } catch (x) {
      ERROR(x);
    }
    return null;
  },

  /** consider using getXIDFromChromeWindow() if you only need the XID */
  getWindowsFromChromeWindow: function(win) {
    let gtkWin = firetray.Window.getGtkWindowHandle(win);
    let gdkWin = firetray.Window.getGdkWindowFromGtkWindow(gtkWin);
    let xid = firetray.Window.getXIDFromGdkWindow(gdkWin);
    LOG("XID="+xid);
    return [gtkWin, gdkWin, xid];
  },

  getXIDFromChromeWindow: function(win) {
    for (let xid in firetray.Handler.windows)
      if (firetray.Handler.windows[xid].chromeWin === win)
        return xid;
    ERROR("unknown window while lookup");
    return null;
  },

  saveWindowPositionAndSize: function(xid) {
    let gx = {}, gy = {}, gwidth = {}, gheight = {};
    firetray.Handler.windows[xid].baseWin.getPositionAndSize(gx, gy, gwidth, gheight);
    firetray.Handler.windows[xid].savedX = gx.value;
    firetray.Handler.windows[xid].savedY = gy.value;
    firetray.Handler.windows[xid].savedWidth = gwidth.value;
    firetray.Handler.windows[xid].savedHeight = gheight.value;
    LOG("save: gx="+gx+", gy="+gy+", gwidth="+gwidth+", gheight="+gheight);
  },

  restoreWindowPositionAndSize: function(xid) {
    if (!firetray.Handler.windows[xid].savedX)
      return; // windows[xid].saved* may not be initialized

    LOG("restore: x="+firetray.Handler.windows[xid].savedX+", y="+firetray.Handler.windows[xid].savedY+", w="+firetray.Handler.windows[xid].savedWidth+", h="+firetray.Handler.windows[xid].savedHeight);
    firetray.Handler.windows[xid].baseWin.setPositionAndSize(
      firetray.Handler.windows[xid].savedX,
      firetray.Handler.windows[xid].savedY,
      firetray.Handler.windows[xid].savedWidth,
      firetray.Handler.windows[xid].savedHeight,
      false); // repaint
  },

  saveWindowState: function(xid) {
    // FIXME: windowState = STATE_MINIMIZED when we're on another virtual
    // desktop... besides we may want to restore the window onto its orininal
    // desktop
    firetray.Handler.windows[xid].savedWindowState =
      firetray.Handler.windows[xid].chromeWin.windowState;
    LOG("save: windowState="+firetray.Handler.windows[xid].savedWindowState);
  },

  restoreWindowState: function(xid) {
    switch (firetray.Handler.windows[xid].savedWindowState) {
    case Ci.nsIDOMChromeWindow.STATE_MAXIMIZED: // 1
      firetray.Handler.windows[xid].chromeWin.maximize();
      break;
    case Ci.nsIDOMChromeWindow.STATE_MINIMIZED: // 2
      firetray.Handler.windows[xid].chromeWin.minimize();
      break;
    case Ci.nsIDOMChromeWindow.STATE_NORMAL: // 3
      break;
    case Ci.nsIDOMChromeWindow.STATE_FULLSCREEN: // 4
      // FIXME: NOT IMPLEMENTED YET
    default:
    }
    LOG("restored WindowState: " + firetray.Handler.windows[xid].chromeWin.windowState);
  },

/* KEPT FOR LATER USE
  onWindowState: function(gtkWidget, gdkEventState, userData) {
    LOG("window-state-event: "+gdkEventState.contents.new_window_state);

    if (gdkEventState.contents.new_window_state & gdk.GDK_WINDOW_STATE_ICONIFIED) {
      let xid = firetray.Window.getXIDFromGtkWidget(gtkWidget);
      LOG(xid+" iconified: "+gdkEventState.contents.changed_mask+" "+gdkEventState.contents.new_window_state);
    }

    let stopPropagation = true; // not usefull
    return stopPropagation;
  },
*/

  checkXWindowEWMState: function(xwin, prop) {
    LOG("xwin="+xwin+" prop="+prop);

    // infos returned by XGetWindowProperty()
    let actual_type = new x11.Atom;
    let actual_format = new ctypes.int;
    let nitems = new ctypes.unsigned_long;
    let bytes_after = new ctypes.unsigned_long;
    let prop_value = new ctypes.unsigned_char.ptr;

    let bufSize = XATOMS_EWMH_WM_STATES.length*ctypes.unsigned_long.size;
    let offset = 0;
    let res = x11.XGetWindowProperty(
      x11.current.Display, xwin, x11.current.Atoms._NET_WM_STATE, offset, bufSize, 0, x11.AnyPropertyType,
      actual_type.address(), actual_format.address(), nitems.address(), bytes_after.address(), prop_value.address());
    LOG("XGetWindowProperty res="+res+", actual_type="+actual_type.value+", actual_format="+actual_format.value+", bytes_after="+bytes_after.value+", nitems="+nitems.value);

    if (!strEquals(res, x11.Success)) {
      ERROR("XGetWindowProperty failed");
      return false;
    }
    if (strEquals(actual_type.value, x11.None)) {
      WARN("property not found");
      return false;
    }

    LOG("prop_value="+prop_value+", size="+prop_value.constructor.size);
    /* If the returned format is 32, the property data will be stored as an
     array of longs (which in a 64-bit application will be 64-bit values
     that are padded in the upper 4 bytes). [man XGetWindowProperty] */
    if (actual_format.value !== 32) {
      ERROR("unsupported format: "+actual_format.value);
      x11.XFree(prop_value);
      return false;
    }
    LOG("format OK");
    var props = ctypes.cast(prop_value, ctypes.unsigned_long.array(nitems.value).ptr);
    LOG("props="+props+", size="+props.constructor.size);

    for (let i=0; i<nitems.value; ++i) {
      LOG(props.contents[i]);
      if (strEquals(props.contents[i], prop))
        return true;
    }

    x11.XFree(prop_value);

    return false;
  },

  filterWindow: function(xev, gdkEv, data) {
    if (!xev)
      return gdk.GDK_FILTER_CONTINUE;

    try {
      let xany = ctypes.cast(xev, x11.XAnyEvent.ptr);
      let xwin = xany.contents.window;

      switch (xany.contents.type) {

      case x11.UnmapNotify:
        LOG("UnmapNotify");
        let isHidden = firetray.Window.checkXWindowEWMState(xwin, x11.current.Atoms._NET_WM_STATE_HIDDEN);
        LOG("isHidden="+isHidden);
        if (isHidden) {
          let hides_on_minimize = firetray.Utils.prefService.getBoolPref('hides_on_minimize');
          let hides_single_window = firetray.Utils.prefService.getBoolPref('hides_single_window');
          if (hides_on_minimize) {
            if (hides_single_window) {
              firetray.Handler.hideSingleWindow(xwin);
            } else
              firetray.Handler.hideAllWindows();
          }
        }
        break;

/* KEPT FOR LATER USE
      case x11.ClientMessage:   // not very useful
        LOG("ClientMessage");
        let xclient = ctypes.cast(xev, x11.XClientMessageEvent.ptr);
        LOG("xclient.data="+xclient.contents.data);
        LOG("message_type="+xclient.contents.message_type+", format="+xclient.contents.format);
        if (strEquals(xclient.contents.data[0], x11.current.Atoms.WM_DELETE_WINDOW)) {
          LOG("Delete Window prevented");
          return gdk.GDK_FILTER_REMOVE;
        }
        break;
*/

      default:
        // LOG("xany.type="+xany.contents.type);
        break;
      }
    } catch(x) {
      ERROR(x);
    }

    return gdk.GDK_FILTER_CONTINUE;
  }

}; // firetray.Window


///////////////////////// firetray.Handler overriding /////////////////////////

// NOTE: storing ctypes pointers into a JS object doesn't work: pointers are
// "evolving" after a while (maybe due to back and forth conversion). So we
// need to store them into a real ctypes array !
firetray.Handler.gtkWindows = new ctypesMap(gtk.GtkWindow.ptr),
firetray.Handler.gdkWindows = new ctypesMap(gdk.GdkWindow.ptr),

/** debug facility */
firetray.Handler.dumpWindows = function() {
  LOG(firetray.Handler.windowsCount);
  for (let winId in firetray.Handler.windows)
    LOG(winId+"="+firetray.Handler.gtkWindows.get(winId));
};

firetray.Handler.registerWindow = function(win) {
  LOG("register window");

  // register
  let [gtkWin, gdkWin, xid] = firetray.Window.getWindowsFromChromeWindow(win);
  this.windows[xid] = {};
  this.windows[xid].chromeWin = win;
  this.windows[xid].baseWin = firetray.Handler.getWindowInterface(win, "nsIBaseWindow");
  try {
    this.gtkWindows.insert(xid, gtkWin);
    this.gdkWindows.insert(xid, gdkWin);
  } catch (x) {
    if (x.name === "RangeError") // instanceof not working :-(
      win.alert(x+"\n\nYou seem to have more than "+FIRETRAY_WINDOW_COUNT_MAX
                +" windows open. This breaks FireTray and most probably "
                +firetray.Handler.appNameOriginal+".");
  }
  this.windowsCount += 1;
  // NOTE: no need to check for window state to set visibility because all
  // windows *are* shown at startup
  this.windows[xid].visibility = true; // this.windows[xid].baseWin.visibility always true :-(
  this.visibleWindowsCount += 1;
  LOG("window "+xid+" registered");
  // NOTE: shouldn't be necessary to gtk_widget_add_events(gtkWin, gdk.GDK_ALL_EVENTS_MASK);

  try {
     // NOTE: we could try to catch the "delete-event" here and block
     // delete_event_cb (in gtk2/nsWindow.cpp), but we prefer to use the
     // provided 'close' JS event

/* KEPT FOR LATER USE
    this.windows[xid].onWindowStateCb = gtk.GCallbackWindowStateEvent_t(firetray.Window.onWindowState);
    this.windows[xid].onWindowStateCbId = gobject.g_signal_connect(gtkWin, "window-state-event", this.windows[xid].onWindowStateCb, null);
    LOG("g_connect window-state-event="+this.windows[xid].onWindowStateCbId);
*/

    this.windows[xid].filterWindowCb = gdk.GdkFilterFunc_t(firetray.Window.filterWindow);
    gdk.gdk_window_add_filter(gdkWin, this.windows[xid].filterWindowCb, null);

  } catch (x) {
    this._unregisterWindowByXID(xid);
    ERROR(x);
    return false;
  }

  LOG("AFTER"); firetray.Handler.dumpWindows();

  return true;
};

firetray.Handler._unregisterWindowByXID = function(xid) {
  this.windowsCount -= 1;
  if (this.windows[xid].visibility) this.visibleWindowsCount -= 1;
  if (this.windows.hasOwnProperty(xid)) {
    if (!delete this.windows[xid])
      throw new DeleteError();
    this.gtkWindows.remove(xid);
    this.gdkWindows.remove(xid);
  } else {
    ERROR("can't unregister unknown window "+xid);
    return false;
  }
  LOG("window "+xid+" unregistered");
  return true;
};

firetray.Handler.getWindowIdFromChromeWindow = firetray.Window.getXIDFromChromeWindow;

firetray.Handler.unregisterWindow = function(win) {
  LOG("unregister window");

  let xid = firetray.Window.getXIDFromChromeWindow(win);
  return this._unregisterWindowByXID(xid);
};

firetray.Handler.showSingleWindow = function(xid) {
  LOG("show xid="+xid);

  // try to restore previous state. TODO: z-order respected ?
  firetray.Window.restoreWindowPositionAndSize(xid);
  firetray.Window.restoreWindowState(xid); // no need to be saved
  firetray.Handler.windows[xid].baseWin.visibility = true; // show

  firetray.Handler.windows[xid].visibility = true;
  firetray.Handler.visibleWindowsCount += 1;
};

// NOTE: we keep using high-level cross-plat BaseWindow.visibility (instead of
// gdk_window_show_unraised)
firetray.Handler.hideSingleWindow = function(xid) {
  LOG("hideSingleWindow");

  firetray.Window.saveWindowPositionAndSize(xid);
  firetray.Window.saveWindowState(xid);
  firetray.Handler.windows[xid].baseWin.visibility = false; // hide

  firetray.Handler.windows[xid].visibility = false;
  firetray.Handler.visibleWindowsCount -= 1;
};

firetray.Handler.showHideAllWindows = function(gtkStatusIcon, userData) {
  LOG("showHideAllWindows: "+userData);
  // NOTE: showHideAllWindows being a callback, we need to use
  // 'firetray.Handler' explicitely instead of 'this'

  LOG("visibleWindowsCount="+firetray.Handler.visibleWindowsCount);
  LOG("windowsCount="+firetray.Handler.windowsCount);
  let visibilityRate = firetray.Handler.visibleWindowsCount/firetray.Handler.windowsCount;
  LOG("visibilityRate="+visibilityRate);
  if (visibilityRate > 0.5)     // TODO: should be configurable
    firetray.Handler.hideAllWindows();
  else
    firetray.Handler.showAllWindows();

  let stopPropagation = true;
  return stopPropagation;
};


/**
 * init X11 Display and handled XAtoms.
 * Needs to be defined and called outside x11.jsm because: gdk already imports
 * x11, and there is no means to get the default Display solely with Xlib
 * without opening one...  :-(
 */
x11.init = function() {
  if (!isEmpty(this.current))
    return true; // init only once

  this.current = {};
  try {
    let gdkDisplay = gdk.gdk_display_get_default();
    this.current.Display = gdk.gdk_x11_display_get_xdisplay(gdkDisplay);
    this.current.Atoms = {};
    XATOMS.forEach(function(atomName, index, array) {
      this.current.Atoms[atomName] = x11.XInternAtom(this.current.Display, atomName, 0);
      LOG("x11.current.Atoms."+atomName+"="+this.current.Atoms[atomName]);
    }, this);
    return true;
  } catch (x) {
    ERROR(x);
    return false;
  }
};
x11.init();
