/* -*- Mode: javascript; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */

var EXPORTED_SYMBOLS = [ "glib" ];

const GLIB_LIBNAME = "glib-2.0";
const GLIB_ABIS    = [ 0 ];

const Cu = Components.utils;
const Cc = Components.classes;
const Ci = Components.interfaces;

Cu.import("resource://gre/modules/ctypes.jsm");
Cu.import("resource://moztray/ctypes-utils.jsm");

function glib_defines(lib) {
  this.GError = ctypes.StructType("GError");
};

if (!glib) {
  var glib = new ctypes_library(GLIB_LIBNAME, GLIB_ABIS, glib_defines);
}
