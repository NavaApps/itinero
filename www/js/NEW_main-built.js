
/*!
 * mustache.js - Logic-less {{mustache}} templates with JavaScript
 * http://github.com/janl/mustache.js
 */

/*global define: false*/

var Mustache;

(function (exports) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = exports; // CommonJS
  } else if (typeof define === "function") {
    define('mustache',exports); // AMD
  } else {
    Mustache = exports; // <script>
  }
}((function () {

  var exports = {};

  exports.name = "mustache.js";
  exports.version = "0.7.0";
  exports.tags = ["{{", "}}"];

  exports.Scanner = Scanner;
  exports.Context = Context;
  exports.Writer = Writer;

  var whiteRe = /\s*/;
  var spaceRe = /\s+/;
  var nonSpaceRe = /\S/;
  var eqRe = /\s*=/;
  var curlyRe = /\s*\}/;
  var tagRe = /#|\^|\/|>|\{|&|=|!/;

  // Workaround for https://issues.apache.org/jira/browse/COUCHDB-577
  // See https://github.com/janl/mustache.js/issues/189
  function testRe(re, string) {
    return RegExp.prototype.test.call(re, string);
  }

  function isWhitespace(string) {
    return !testRe(nonSpaceRe, string);
  }

  var isArray = Array.isArray || function (obj) {
    return Object.prototype.toString.call(obj) === "[object Array]";
  };

  function escapeRe(string) {
    return string.replace(/[\-\[\]{}()*+?.,\\\^$|#\s]/g, "\\$&");
  }

  var entityMap = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': '&quot;',
    "'": '&#39;',
    "/": '&#x2F;'
  };

  function escapeHtml(string) {
    return String(string).replace(/[&<>"'\/]/g, function (s) {
      return entityMap[s];
    });
  }

  // Export the escaping function so that the user may override it.
  // See https://github.com/janl/mustache.js/issues/244
  exports.escape = escapeHtml;

  function Scanner(string) {
    this.string = string;
    this.tail = string;
    this.pos = 0;
  }

  /**
   * Returns `true` if the tail is empty (end of string).
   */
  Scanner.prototype.eos = function () {
    return this.tail === "";
  };

  /**
   * Tries to match the given regular expression at the current position.
   * Returns the matched text if it can match, the empty string otherwise.
   */
  Scanner.prototype.scan = function (re) {
    var match = this.tail.match(re);

    if (match && match.index === 0) {
      this.tail = this.tail.substring(match[0].length);
      this.pos += match[0].length;
      return match[0];
    }

    return "";
  };

  /**
   * Skips all text until the given regular expression can be matched. Returns
   * the skipped string, which is the entire tail if no match can be made.
   */
  Scanner.prototype.scanUntil = function (re) {
    var match, pos = this.tail.search(re);

    switch (pos) {
    case -1:
      match = this.tail;
      this.pos += this.tail.length;
      this.tail = "";
      break;
    case 0:
      match = "";
      break;
    default:
      match = this.tail.substring(0, pos);
      this.tail = this.tail.substring(pos);
      this.pos += pos;
    }

    return match;
  };

  function Context(view, parent) {
    this.view = view;
    this.parent = parent;
    this.clearCache();
  }

  Context.make = function (view) {
    return (view instanceof Context) ? view : new Context(view);
  };

  Context.prototype.clearCache = function () {
    this._cache = {};
  };

  Context.prototype.push = function (view) {
    return new Context(view, this);
  };

  Context.prototype.lookup = function (name) {
    var value = this._cache[name];

    if (!value) {
      if (name === ".") {
        value = this.view;
      } else {
        var context = this;

        while (context) {
          if (name.indexOf(".") > 0) {
            var names = name.split("."), i = 0;

            value = context.view;

            while (value && i < names.length) {
              value = value[names[i++]];
            }
          } else {
            value = context.view[name];
          }

          if (value != null) {
            break;
          }

          context = context.parent;
        }
      }

      this._cache[name] = value;
    }

    if (typeof value === "function") {
      value = value.call(this.view);
    }

    return value;
  };

  function Writer() {
    this.clearCache();
  }

  Writer.prototype.clearCache = function () {
    this._cache = {};
    this._partialCache = {};
  };

  Writer.prototype.compile = function (template, tags) {
    var fn = this._cache[template];

    if (!fn) {
      var tokens = exports.parse(template, tags);
      fn = this._cache[template] = this.compileTokens(tokens, template);
    }

    return fn;
  };

  Writer.prototype.compilePartial = function (name, template, tags) {
    var fn = this.compile(template, tags);
    this._partialCache[name] = fn;
    return fn;
  };

  Writer.prototype.compileTokens = function (tokens, template) {
    var fn = compileTokens(tokens);
    var self = this;

    return function (view, partials) {
      if (partials) {
        if (typeof partials === "function") {
          self._loadPartial = partials;
        } else {
          for (var name in partials) {
            self.compilePartial(name, partials[name]);
          }
        }
      }

      return fn(self, Context.make(view), template);
    };
  };

  Writer.prototype.render = function (template, view, partials) {
    return this.compile(template)(view, partials);
  };

  Writer.prototype._section = function (name, context, text, callback) {
    var value = context.lookup(name);

    switch (typeof value) {
    case "object":
      if (isArray(value)) {
        var buffer = "";

        for (var i = 0, len = value.length; i < len; ++i) {
          buffer += callback(this, context.push(value[i]));
        }

        return buffer;
      }

      return value ? callback(this, context.push(value)) : "";
    case "function":
      var self = this;
      var scopedRender = function (template) {
        return self.render(template, context);
      };

      var result = value.call(context.view, text, scopedRender);
      return result != null ? result : "";
    default:
      if (value) {
        return callback(this, context);
      }
    }

    return "";
  };

  Writer.prototype._inverted = function (name, context, callback) {
    var value = context.lookup(name);

    // Use JavaScript's definition of falsy. Include empty arrays.
    // See https://github.com/janl/mustache.js/issues/186
    if (!value || (isArray(value) && value.length === 0)) {
      return callback(this, context);
    }

    return "";
  };

  Writer.prototype._partial = function (name, context) {
    if (!(name in this._partialCache) && this._loadPartial) {
      this.compilePartial(name, this._loadPartial(name));
    }

    var fn = this._partialCache[name];

    return fn ? fn(context) : "";
  };

  Writer.prototype._name = function (name, context) {
    var value = context.lookup(name);

    if (typeof value === "function") {
      value = value.call(context.view);
    }

    return (value == null) ? "" : String(value);
  };

  Writer.prototype._escaped = function (name, context) {
    return exports.escape(this._name(name, context));
  };

  /**
   * Calculates the bounds of the section represented by the given `token` in
   * the original template by drilling down into nested sections to find the
   * last token that is part of that section. Returns an array of [start, end].
   */
  function sectionBounds(token) {
    var start = token[3];
    var end = start;

    var tokens;
    while ((tokens = token[4]) && tokens.length) {
      token = tokens[tokens.length - 1];
      end = token[3];
    }

    return [start, end];
  }

  /**
   * Low-level function that compiles the given `tokens` into a function
   * that accepts three arguments: a Writer, a Context, and the template.
   */
  function compileTokens(tokens) {
    var subRenders = {};

    function subRender(i, tokens, template) {
      if (!subRenders[i]) {
        var fn = compileTokens(tokens);
        subRenders[i] = function (writer, context) {
          return fn(writer, context, template);
        };
      }

      return subRenders[i];
    }

    return function (writer, context, template) {
      var buffer = "";
      var token, sectionText;

      for (var i = 0, len = tokens.length; i < len; ++i) {
        token = tokens[i];

        switch (token[0]) {
        case "#":
          sectionText = template.slice.apply(template, sectionBounds(token));
          buffer += writer._section(token[1], context, sectionText, subRender(i, token[4], template));
          break;
        case "^":
          buffer += writer._inverted(token[1], context, subRender(i, token[4], template));
          break;
        case ">":
          buffer += writer._partial(token[1], context);
          break;
        case "&":
          buffer += writer._name(token[1], context);
          break;
        case "name":
          buffer += writer._escaped(token[1], context);
          break;
        case "text":
          buffer += token[1];
          break;
        }
      }

      return buffer;
    };
  }

  /**
   * Forms the given array of `tokens` into a nested tree structure where
   * tokens that represent a section have a fifth item: an array that contains
   * all tokens in that section.
   */
  function nestTokens(tokens) {
    var tree = [];
    var collector = tree;
    var sections = [];
    var token, section;

    for (var i = 0; i < tokens.length; ++i) {
      token = tokens[i];

      switch (token[0]) {
      case "#":
      case "^":
        token[4] = [];
        sections.push(token);
        collector.push(token);
        collector = token[4];
        break;
      case "/":
        if (sections.length === 0) {
          throw new Error("Unopened section: " + token[1]);
        }

        section = sections.pop();

        if (section[1] !== token[1]) {
          throw new Error("Unclosed section: " + section[1]);
        }

        if (sections.length > 0) {
          collector = sections[sections.length - 1][4];
        } else {
          collector = tree;
        }
        break;
      default:
        collector.push(token);
      }
    }

    // Make sure there were no open sections when we're done.
    section = sections.pop();

    if (section) {
      throw new Error("Unclosed section: " + section[1]);
    }

    return tree;
  }

  /**
   * Combines the values of consecutive text tokens in the given `tokens` array
   * to a single token.
   */
  function squashTokens(tokens) {
    var token, lastToken, squashedTokens = [];

    for (var i = 0; i < tokens.length; ++i) {
      token = tokens[i];

      if (lastToken && lastToken[0] === "text" && token[0] === "text") {
        lastToken[1] += token[1];
        lastToken[3] = token[3];
      } else {
        lastToken = token;
        squashedTokens.push(token);
      }
    }

    return squashedTokens; 
  }

  function escapeTags(tags) {
    if (tags.length !== 2) {
      throw new Error("Invalid tags: " + tags.join(" "));
    }

    return [
      new RegExp(escapeRe(tags[0]) + "\\s*"),
      new RegExp("\\s*" + escapeRe(tags[1]))
    ];
  }

  /**
   * Breaks up the given `template` string into a tree of token objects. If
   * `tags` is given here it must be an array with two string values: the
   * opening and closing tags used in the template (e.g. ["<%", "%>"]). Of
   * course, the default is to use mustaches (i.e. Mustache.tags).
   */
  exports.parse = function (template, tags) {
    tags = tags || exports.tags;

    var tagRes = escapeTags(tags);
    var scanner = new Scanner(template);

    var tokens = [],      // Buffer to hold the tokens
        spaces = [],      // Indices of whitespace tokens on the current line
        hasTag = false,   // Is there a {{tag}} on the current line?
        nonSpace = false; // Is there a non-space char on the current line?

    // Strips all whitespace tokens array for the current line
    // if there was a {{#tag}} on it and otherwise only space.
    function stripSpace() {
      if (hasTag && !nonSpace) {
        while (spaces.length) {
          tokens.splice(spaces.pop(), 1);
        }
      } else {
        spaces = [];
      }

      hasTag = false;
      nonSpace = false;
    }

    var start, type, value, chr;

    while (!scanner.eos()) {
      start = scanner.pos;
      value = scanner.scanUntil(tagRes[0]);

      if (value) {
        for (var i = 0, len = value.length; i < len; ++i) {
          chr = value.charAt(i);

          if (isWhitespace(chr)) {
            spaces.push(tokens.length);
          } else {
            nonSpace = true;
          }

          tokens.push(["text", chr, start, start + 1]);
          start += 1;

          if (chr === "\n") {
            stripSpace(); // Check for whitespace on the current line.
          }
        }
      }

      start = scanner.pos;

      // Match the opening tag.
      if (!scanner.scan(tagRes[0])) {
        break;
      }

      hasTag = true;
      type = scanner.scan(tagRe) || "name";

      // Skip any whitespace between tag and value.
      scanner.scan(whiteRe);

      // Extract the tag value.
      if (type === "=") {
        value = scanner.scanUntil(eqRe);
        scanner.scan(eqRe);
        scanner.scanUntil(tagRes[1]);
      } else if (type === "{") {
        var closeRe = new RegExp("\\s*" + escapeRe("}" + tags[1]));
        value = scanner.scanUntil(closeRe);
        scanner.scan(curlyRe);
        scanner.scanUntil(tagRes[1]);
        type = "&";
      } else {
        value = scanner.scanUntil(tagRes[1]);
      }

      // Match the closing tag.
      if (!scanner.scan(tagRes[1])) {
        throw new Error("Unclosed tag at " + scanner.pos);
      }

      tokens.push([type, value, start, scanner.pos]);

      if (type === "name" || type === "{" || type === "&") {
        nonSpace = true;
      }

      // Set the tags for the next time around.
      if (type === "=") {
        tags = value.split(spaceRe);
        tagRes = escapeTags(tags);
      }
    }

    tokens = squashTokens(tokens);

    return nestTokens(tokens);
  };

  // The high-level clearCache, compile, compilePartial, and render functions
  // use this default writer.
  var _writer = new Writer();

  /**
   * Clears all cached templates and partials in the default writer.
   */
  exports.clearCache = function () {
    return _writer.clearCache();
  };

  /**
   * Compiles the given `template` to a reusable function using the default
   * writer.
   */
  exports.compile = function (template, tags) {
    return _writer.compile(template, tags);
  };

  /**
   * Compiles the partial with the given `name` and `template` to a reusable
   * function using the default writer.
   */
  exports.compilePartial = function (name, template, tags) {
    return _writer.compilePartial(name, template, tags);
  };

  /**
   * Compiles the given array of tokens (the output of a parse) to a reusable
   * function using the default writer.
   */
  exports.compileTokens = function (tokens, template) {
    return _writer.compileTokens(tokens, template);
  };

  /**
   * Renders the `template` with the given `view` and `partials` using the
   * default writer.
   */
  exports.render = function (template, view, partials) {
    return _writer.render(template, view, partials);
  };

  // This is here for backwards compatibility with 0.4.x.
  exports.to_html = function (template, view, partials, send) {
    var result = exports.render(template, view, partials);

    if (typeof send === "function") {
      send(result);
    } else {
      return result;
    }
  };

  return exports;

}())));

/*jslint devel: true, browser: true, white: true, nomen: true *//*global jWorkflow: false *//* ===========================================================================
 * AliceJS
 *
 * @description
 * A Lightweight Independent CSS Engine
 *
 * @author Laurent Hasson (@ldhasson)       [original]
 * @author Jim Ing (@jim_ing)               [original]
 * @author Gord Tanner (@gtanner)           [contributor, jWorkflow]
 * @author Matt Lantz (@mattylantz)         [contributor] 
 * 
 * ===========================================================================
 *
 * Copyright 2011-2012 Research In Motion Limited.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *///===================================================================================
/*
 * jWorkflow is embedded directly into the core to ensure we can do sequencial animations
 *
 *   ** Licensed Under **
 *
 *   The MIT License
 *   http://www.opensource.org/licenses/mit-license.php
 *
 *   Copyright (c) 2010 all contributors:
 *
 *   Gord Tanner
 *   tinyHippos Inc.
 */// jWorkflow.js
// (c) 2010 tinyHippos inc.
// jWorkflow is freely distributable under the terms of the MIT license.
// Portions of jWorkflow are inspired by Underscore.js
var jWorkflow=function(){function e(e){if(typeof e!="function")throw"expected function but was "+typeof e}function t(e){return typeof e.andThen=="function"&&typeof e.start=="function"&&typeof e.chill=="function"}function n(e){return!!e.map&&!!e.reduce}var r={order:function(r,i){var s=[],o,u=null,a=function(){var e=!1;return{take:function(){e=!0},pass:function(t){var n;e=!1,o.length?(n=o.shift(),t=n.func.apply(n.context,[t,a]),e||a.pass(t)):u.func&&u.func.apply(u.context,[t])},drop:function(t){e=!0,o=[],setTimeout(function(){a.pass(t)},1)}}}(),f={andThen:function(r,i){if(t(r)){var o=function(e,t){t.take(),r.start({callback:function(e){t.pass(e)},context:i,initialValue:e})};s.push({func:o,context:i})}else if(n(r)){var u=function(e,t){t.take();var n=r.length,i=function(){return--n||t.pass()};r.forEach(function(e){jWorkflow.order(e).start(i)})};s.push({func:u,context:i})}else e(r),s.push({func:r,context:i});return f},chill:function(e){return f.andThen(function(t,n){n.take(),setTimeout(function(){n.pass(t)},e)})},start:function(){var e,t,n;arguments[0]&&typeof arguments[0]=="object"?(e=arguments[0].callback,t=arguments[0].context,n=arguments[0].initialValue):(e=arguments[0],t=arguments[1]),u={func:e,context:t},o=s.slice(),a.pass(n)}};return r?f.andThen(r,i):f}};return r}();typeof module=="object"&&typeof require=="function"&&(module.exports=jWorkflow);var alice=function(){"use strict";var e={id:"alice",name:"AliceJS",description:"A Lightweight Independent CSS Engine",version:"0.5",build:"20121002-0159",prefix:"",prefixJS:"",elems:null,cleaner:{},format:{},helper:{},plugins:{},anima:null,debug:!1,elements:function(e){var t,n=[],r=function(e,t){Array.prototype.forEach.apply(e,[t])},i=function(e){n.push(e)},s=function(e){if(typeof e!="string")return[];var t=document.getElementById(e);return t?[t]:document.querySelectorAll(e)};if(typeof e=="string")if(e.indexOf("$")===0)if(e.indexOf("#")>-1)t=e.substring(e.indexOf("#")+1,e.indexOf("')")),r(s(t),i);else{if(!(e.indexOf(".")>-1)){console.warn("jQuery selectors must be either classes or ids.");return}t=e.substring(e.indexOf(".")+1,e.indexOf("')")),r(s(t),i)}else r(s(e),i);else e.length===undefined?n.push(e):r(e,function(e){e.nodeType&&e.nodeType!==3?n.push(e):r(s(e),i)});return n},randomize:function(e,t){var n,r,i=parseInt(e,10);return typeof t=="string"&&t.indexOf("%")>-1?n=parseInt(t,10)/100:n=parseFloat(t,10),r=i+i*(Math.random()*2*n-n),Math.floor(r)},duration:function(e){var t,n=function(e){return e},r=function(e){var t;return e.indexOf("ms")>-1?t=parseInt(e,10):e.indexOf("s")>-1?t=parseFloat(e,10)*1e3:t=parseInt(e,10),t},i=function(e){var t;return e.value&&(typeof e.value=="string"?t=r(e.value):t=n(e.value)),t};switch(typeof e){case"number":t=n(e);break;case"string":t=r(e);break;case"object":t=i(e);break;default:t=e}return t},coords:function(e){var t={"top-left":{x:"0%",y:"0%"},"top-center":{x:"50%",y:"0%"},"top-right":{x:"100%",y:"0%"},"middle-left":{x:"0%",y:"50%"},"middle-center":{x:"50%",y:"50%"},"middle-right":{x:"100%",y:"50%"},"bottom-left":{x:"0%",y:"100%"},"bottom-center":{x:"50%",y:"100%"},"bottom-right":{x:"100%",y:"100%"},top:{x:"50%",y:"0%"},left:{x:"0%",y:"50%"},center:{x:"50%",y:"50%"},right:{x:"100%",y:"50%"},bottom:{x:"50%",y:"100%"},NW:{x:"0%",y:"0%"},N:{x:"50%",y:"0%"},NE:{x:"100%",y:"0%"},W:{x:"0%",y:"50%"},E:{x:"100%",y:"50%"},SW:{x:"0%",y:"100%"},S:{x:"50%",y:"100%"},SE:{x:"100%",y:"100%"},"":{x:"50%",y:"50%"},"undefined":{x:"50%",y:"50%"}};return t[e]},easing:function(e){var t={linear:{p1:.25,p2:.25,p3:.75,p4:.75},ease:{p1:.25,p2:.1,p3:.25,p4:1},"ease-in":{p1:.42,p2:0,p3:1,p4:1},"ease-out":{p1:0,p2:0,p3:.58,p4:1},"ease-in-out":{p1:.42,p2:0,p3:.58,p4:1},easeInQuad:{p1:.55,p2:.085,p3:.68,p4:.53},easeInCubic:{p1:.55,p2:.055,p3:.675,p4:.19},easeInQuart:{p1:.895,p2:.03,p3:.685,p4:.22},easeInQuint:{p1:.755,p2:.05,p3:.855,p4:.06},easeInSine:{p1:.47,p2:0,p3:.745,p4:.715},easeInExpo:{p1:.95,p2:.05,p3:.795,p4:.035},easeInCirc:{p1:.6,p2:.04,p3:.98,p4:.335},easeInBack:{p1:.6,p2:-0.28,p3:.735,p4:.045},easeOutQuad:{p1:.25,p2:.46,p3:.45,p4:.94},easeOutCubic:{p1:.215,p2:.61,p3:.355,p4:1},easeOutQuart:{p1:.165,p2:.84,p3:.44,p4:1},easeOutQuint:{p1:.23,p2:1,p3:.32,p4:1},easeOutSine:{p1:.39,p2:.575,p3:.565,p4:1},easeOutExpo:{p1:.19,p2:1,p3:.22,p4:1},easeOutCirc:{p1:.075,p2:.82,p3:.165,p4:1},easeOutBack:{p1:.175,p2:.885,p3:.32,p4:1.275},easeInOutQuad:{p1:.455,p2:.03,p3:.515,p4:.955},easeInOutCubic:{p1:.645,p2:.045,p3:.355,p4:1},easeInOutQuart:{p1:.77,p2:0,p3:.175,p4:1},easeInOutQuint:{p1:.86,p2:0,p3:.07,p4:1},easeInOutSine:{p1:.445,p2:.05,p3:.55,p4:.95},easeInOutExpo:{p1:1,p2:0,p3:0,p4:1},easeInOutCirc:{p1:.785,p2:.135,p3:.15,p4:.86},easeInOutBack:{p1:.68,p2:-0.55,p3:.265,p4:1.55},custom:{p1:0,p2:.35,p3:.5,p4:1.3},random:{p1:Math.random().toPrecision(3),p2:Math.random().toPrecision(3),p3:Math.random().toPrecision(3),p4:Math.random().toPrecision(3)}};return t[e]?t[e]:{p1:.42,p2:0,p3:.58,p4:1}},flip:function(e,t,n){var r=t||1,i,s=function(e){return{start:0,end:e,axis:"Y"}},o=function(t){switch(e){case"left":return{start:0,end:-360*r,axis:"Y"};case"right":return{start:0,end:360*r,axis:"Y"};case"up":return{start:0,end:360*r,axis:"X"};case"down":return{start:0,end:-360*r,axis:"X"}}},u=function(e){var t;return e.value&&(typeof e.value=="string"?t=o(e.value):t=s(e.value)),t};switch(typeof e){case"number":i=s(e);break;case"string":i=o(e);break;case"object":i=u(e);break;default:i=null}return i},percentage:function(e){var t;return typeof e=="string"?e.indexOf("%")>-1||e.indexOf("°")>-1?t=parseInt(e,10)/100:e>=1||e<=-1?t=parseInt(e,10)/100:t=parseFloat(e,10):typeof e=="number"&&(e>=1||e<=-1?t=e/100:t=e),t},vendorPrefix:function(){var e=document.createElement("div");"webkitAnimation"in e.style?(this.prefix="-webkit-",this.prefixJS="webkit"):"MozAnimation"in e.style?(this.prefix="-moz-",this.prefixJS="Moz"):"msAnimation"in e.style?(this.prefix="-ms-",this.prefixJS="ms"):"OAnimation"in e.style||"OTransform"in e.style?(this.prefix="-o-",this.prefixJS="O"):(this.prefix="",this.prefixJS=""),this.debug&&console.log("prefix="+this.prefix,"prefixJS="+this.prefixJS);return},docHeight:function(){var e=document;return Math.max(Math.max(e.body.scrollHeight,e.documentElement.scrollHeight),Math.max(e.body.offsetHeight,e.documentElement.offsetHeight),Math.max(e.body.clientHeight,e.documentElement.clientHeight))},pixel:function(e,t){if(typeof e=="number")return e%1===0?e:parseFloat(e,10)*t;if(e.indexOf("px")>-1)return parseInt(e,10);if(e.indexOf("%")>-1)return Math.round(parseInt(e,10)/100*t)},keyframeInsert:function(e){if(document.styleSheets&&document.styleSheets.length){var t=0;try{document.styleSheets[0].cssRules.length>0&&(t=document.styleSheets[0].cssRules.length),document.styleSheets[0].insertRule(e,t)}catch(n){console.warn(n.message,e)}}else{var r=document.createElement("style");r.innerHTML=e,document.head.appendChild(r)}return},keyframeDelete:function(e){var t=document.all?"rules":"cssRules",n;for(n=0;n<document.styleSheets[0][t].length;n+=1)if(document.styleSheets[0][t][n].name===e){document.styleSheets[0].deleteRule(n),this.debug&&console.log("Deleted keyframe: "+e);break}return},clearAnimation:function(e){this.style[this.prefixJS+"AnimationName"]=" ",this.style[this.prefixJS+"AnimationDelay"]=" ",this.style[this.prefixJS+"AnimationDuration"]=" ",this.style[this.prefixJS+"AnimationTimingFunction"]=" ",this.style[this.prefixJS+"AnimationIterationCount"]=" ",this.style[this.prefixJS+"AnimationDirection"]=" ",this.style[this.prefixJS+"AnimationPlayState"]=" ",alice.keyframeDelete(e.animationName);return},init:function(t){console.info("Initializing "+this.name+" ("+this.description+") "+this.version),this.vendorPrefix(),t&&t.elems&&(this.elems=this.elements(t.elems));if(t&&t.workflow===!0){console.log("jWorkflow: enabled");var n=t&&t.id?t.id:"",r=jWorkflow.order(),i={delay:function(e){return r.chill(e),i},log:function(e){return r.andThen(function(){console.log(e)}),i},custom:function(e){return r.andThen(e),i},start:function(){r.start(function(){console.info("workflow.start")})}};return Array.prototype.forEach.call(Object.keys(e.plugins),function(t){var s=e.plugins[t];i[t]=function(){var e=arguments;return r.andThen(function(){s.apply(document.getElementById(n),e)}),i}}),i}return console.log("jWorkflow: disabled"),e.plugins}};return e}();alice.format={duration:function(e){"use strict";var t=0,n=0,r=0;return t=alice.duration(e),r=t,e.randomness&&(n=alice.randomize(t,alice.percentage(e.randomness)),r=Math.abs(n)),r+"ms"},easing:function(e){"use strict";var t=alice.easing(e),n="cubic-bezier("+t.p1+", "+t.p2+", "+t.p3+", "+t.p4+")";return n},coords:function(e){"use strict";var t=alice.coords(e),n=t.x+" "+t.y;return n},oppositeNumber:function(e){"use strict";return-e}},alice.helper={duration:function(e,t,n){"use strict";return e&&e.offset?t?t=parseInt(t,10)+parseInt(e.offset,10):t=parseInt(alice.format.duration(n),10):t=parseInt(alice.format.duration(n),10),t+="ms",t},rotation:function(e,t){"use strict";var n=e;return t.randomness&&(n=alice.randomize(n,alice.percentage(t.randomness))),n}},alice.cleaner={removeAni:function(e){"use strict";var t,n;document.addEventListener(alice.prefixJS+"AnimationEnd",function(){n=alice.elements(e);for(t=0;t<n.length;t++)document.getElementById(n[t].getAttribute("id")).removeAttribute("style")},!1)},removeElems:function(e){"use strict";var t,n;document.addEventListener(alice.prefixJS+"AnimationEnd",function(){n=alice.elements(e);for(t=0;t<n.length;t++){var r=document.getElementById(n[t].getAttribute("id"));r.parentNode.removeChild(r)}},!1)}};var alicejs=alice.init();alice.plugins.cheshire=function(e){"use strict";console.info("cheshire",e);var t=e.delay||"0ms",n=e.duration||"2000ms",r=e.timing||"ease",i=e.iteration||1,s=e.direction||"normal",o=e.playstate||"running",u=e.perspective||"1000",a=e.perspectiveOrigin||"center",f=e.backfaceVisibility||"visible",l=alice.percentage(e.overshoot)||0,c=85,h=e.rotate||0,p=e.turns||1,d=alice.flip(e.flip,p,l),v=e.fade&&e.fade!==""?e.fade:null,m=v&&v==="out"?1:0,g=v&&v==="out"?0:1,y=e.scale&&e.scale.from?alice.percentage(e.scale.from):1,b=e.scale&&e.scale.to?alice.percentage(e.scale.to):1,w=e.shadow||!1,E="",S="",x=1,T=0,N=e.posEnd||0,C=N+x*Math.floor(N*l),k=e.cleanUp||"partial",L={},A,O,M,_,D,P,H,B,j,F,I,q,R,U;e.cleanUp==="partial"?alice.cleaner.removeAni(e.elems):e.cleanUp==="total"&&alice.cleaner.removeElems(e.elems),O=alice.elements(e.elems);if(O&&O.length>0)for(_=0;_<O.length;_+=1){M=O[_],A=M.parentElement||M.parentNode,L.delay=alice.helper.duration(e.delay,L.delay,t),L.duration=alice.helper.duration(e.duration,L.duration,n),L.rotate=alice.helper.rotation(h,e),L.rotateStart=alice.percentage(L.rotate)*100,L.rotateOver=l*100,L.rotateEnd=0,D=alice.id+"-cheshire-"+(new Date).getTime()+"-"+Math.floor(Math.random()*1e6);if(e.move){q=e.move.direction||e.move;switch(q){case"left":E="Left",S="X",x=-1,R=window.innerWidth,T=e.move.start?alice.pixel(e.move.start,R):R,N=e.move.end?alice.pixel(e.move.end,R):0,C=x*Math.floor(T*l);break;case"right":E="Right",S="X",x=1,R=document.body.offsetWidth-M.clientWidth,T=e.move.start?alice.pixel(e.move.start,R):0,N=e.move.end?alice.pixel(e.move.end,R):R,C=N+x*Math.floor(N*l);break;case"up":E="Up",S="Y",x=-1,R=window.innerHeight,T=e.move.start?alice.pixel(e.move.start,R):R,N=e.move.end?alice.pixel(e.move.end,R):0,C=x*Math.floor(T*l);break;case"down":E="Down",S="Y",x=1,R=alice.docHeight()-A.clientHeight*3,T=e.move.start?alice.pixel(e.move.start,R):0,N=e.move.end?alice.pixel(e.move.end,R):R,C=N+x*Math.floor(N*l),alice.debug&&console.log(alice.docHeight(),window.innerHeight,window.pageYOffset,A.clientHeight)}}H="",H+=d?" rotate"+d.axis+"("+d.start+"deg)":" translate"+S+"("+T+"px)",H+=L.rotate&&parseInt(L.rotate,10)!==0?" rotate("+L.rotateStart+"deg)":"",H+=" scale("+y+")",B="",B+=d?" rotate"+d.axis+"("+Math.floor((1+l)*d.end)+"deg)":" translate"+S+"("+C+"px)",B+=L.rotate&&parseInt(L.rotate,10)!==0?" rotate("+L.rotateOver+"deg)":"",B+=b>1?" scale("+b+")":"",B+=" scale("+b+")",j="",j+=d?" rotate"+d.axis+"("+d.end+"deg)":" translate"+S+"("+N+"px)",E===""&&s==="alternate"?j+=" rotate("+ -L.rotateStart+"deg)":j+=L.rotate&&parseInt(L.rotate,10)!==0?" rotate("+L.rotateEnd+"deg)":"",j+=" scale("+b+")",w===!0&&b>1&&(U=Math.round(b*10),F=" 0px 0px 0px rgba(0, 0, 0, 1)",I=" "+U+"px "+U+"px "+U+"px rgba(0, 0, 0, 0.5)"),P="",P+="@"+alice.prefix+"keyframes "+D+" {\n",P+="	0% {\n",P+="		"+alice.prefix+"transform:"+H+";"+"\n",P+="		"+alice.prefix+"transform-origin:"+alice.format.coords(a)+";"+"\n",P+=v?"		opacity: "+m+";"+"\n":"",P+=w===!0&&b>1?"		"+alice.prefix+"box-shadow: "+F+";"+"\n":"",P+="	}\n",l!==0&&(P+="	"+c+"% {\n",P+="		"+alice.prefix+"transform:"+B+";"+"\n",P+="		"+alice.prefix+"transform-origin:"+alice.format.coords(a)+";"+"\n",P+="	}\n"),P+="	100% {\n",P+="		"+alice.prefix+"transform:"+j+";"+"\n",P+="		"+alice.prefix+"transform-origin:"+alice.format.coords(a)+";"+"\n",P+=v?"		opacity: "+g+";"+"\n":"",P+=w===!0&&b>1?"		"+alice.prefix+"box-shadow: "+I+";"+"\n":"",P+="	}\n",P+="}\n",console.log(P),alice.keyframeInsert(P),A.style[alice.prefixJS+"Perspective"]=u+"px",A.style[alice.prefixJS+"PerspectiveOrigin"]=alice.format.coords(a),M.style[alice.prefixJS+"BackfaceVisibility"]=f,M.style[alice.prefixJS+"AnimationName"]=D,M.style[alice.prefixJS+"AnimationDelay"]=L.delay,M.style[alice.prefixJS+"AnimationDuration"]=L.duration,M.style[alice.prefixJS+"AnimationTimingFunction"]=alice.format.easing(r),M.style[alice.prefixJS+"AnimationIterationCount"]=i,M.style[alice.prefixJS+"AnimationDirection"]=s,M.style[alice.prefixJS+"AnimationPlayState"]=o,M.style[alice.prefixJS+"Transform"]=j,M.style.opacity=v?g:"",M.style[alice.prefixJS+"BoxShadow"]=w===!0&&b>1?I:"","MozAnimation"in M.style?M.addEventListener("animationend",alice.clearAnimation,!1):M.addEventListener(alice.prefixJS+"AnimationEnd",alice.clearAnimation,!1),alice.debug&&(console.log(P),console.log(A.style),console.log(M.id,alice.prefixJS,M.style,M.style.cssText,M.style[alice.prefixJS+"AnimationDuration"],M.style[alice.prefixJS+"AnimationTimingFunction"]))}else console.warn("No elements!");return e},alice.plugins.bounce=function(e){"use strict";console.info("bounce: ",arguments),e||(e="");var t={from:"100%",to:"150%"};e.scale&&(typeof e.scale=="object"?t=e.scale:t.to=e.scale);var n={elems:e.elems||alice.anima,scale:t,shadow:e.shadow||!0,duration:e.duration||"750ms",timing:e.timing||"easeOutSine",delay:e.delay||"0ms",iteration:e.iteration||"infinite",direction:e.direction||"alternate",playstate:e.playstate||"running"};return alice.plugins.cheshire(n),n},alice.plugins.dance=function(e){"use strict";console.info("dance: ",arguments),e||(e="");var t={elems:e.elems||alice.anima,rotate:e.rotate||45,duration:e.duration||"750ms",timing:e.timing||"easeInOutBack",delay:e.delay||"0ms",iteration:e.iteration||"infinite",direction:e.direction||"alternate",playstate:e.playstate||"running"};return alice.plugins.cheshire(t),t},alice.plugins.drain=function(e){"use strict";console.info("drain: ",arguments),e||(e="");var t={scale:e.fade==="in"?{from:"0%",to:"100%"}:{from:"100%",to:"0%"},elems:e.elems||alice.anima,rotate:e.rotate||-2880,duration:e.duration||"4500ms",timing:e.timing||"ease-in-out",delay:e.delay||"0ms",iteration:e.iteration||1,direction:e.direction||"normal",playstate:e.playstate||"running"};return alice.plugins.cheshire(t),t},alice.plugins.fade=function(e){"use strict";console.info("fade: ",arguments),e||(e="");var t={elems:e.elems||alice.anima,fade:e.fade||"in",duration:e.duration||"4500ms",timing:e.timing||"ease-in-out",delay:e.delay||"0ms",iteration:e.iteration||1,direction:e.direction||"normal",playstate:e.playstate||"running"};return alice.plugins.cheshire(t),t},alice.plugins.hinge=function(e){"use strict";console.info("hinge: ",arguments),e||(e="");var t={perspectiveOrigin:"top-left",elems:e.elems||alice.anima,rotate:e.rotate||25,overshoot:e.overshoot||0,duration:e.duration||"1000ms",timing:e.timing||"linear",delay:e.delay||"0ms",iteration:e.iteration||"infinite",direction:e.direction||"alternate",playstate:e.playstate||"running"};return alice.plugins.cheshire(t),t},alice.plugins.pageFlip=function(e){"use strict";console.info("pageFlip: ",arguments),e||(e="");var t="";switch(e.flipDirection){case"right":t="right";break;case"up":t="top";break;case"down":t="bottom"}var n={perspectiveOrigin:t||"left",elems:e.elems||alice.anima,flip:e.flipDirection||"left",turns:e.turns||1,overshoot:e.overshoot||0,duration:e.duration||"2000ms",timing:e.timing||"ease-in-out",delay:e.delay||"0ms",iteration:e.iteration||"infinite",direction:e.direction||"normal",playstate:e.playstate||"running"};return alice.plugins.cheshire(n),n},alice.plugins.pendulum=function(e){"use strict";console.info("pendulum: ",arguments),e||(e="");var t={perspectiveOrigin:"top",elems:e.elems||alice.anima,rotate:e.rotate||45,overshoot:e.overshoot||0,duration:e.duration||"2000ms",timing:e.timing||"ease-in-out",delay:e.delay||"0ms",iteration:e.iteration||"infinite",direction:e.direction||"alternate",playstate:e.playstate||"running"};return alice.plugins.cheshire(t),t},alice.plugins.phantomZone=function(e){"use strict";console.info("phantomZone: ",arguments),e||(e="");var t={scale:e.fade==="in"?{from:"1%",to:"100%"}:{from:"100%",to:"1%"},elems:e.elems||alice.anima,rotate:e.rotate||-720,flip:e.flip||"left",duration:e.duration||"5000ms",timing:e.timing||"ease-in-out",delay:e.delay||"0ms",iteration:e.iteration||1,direction:e.direction||"normal",playstate:e.playstate||"running"};return alice.plugins.cheshire(t),t},alice.plugins.raceFlag=function(e){"use strict";console.info("raceFlag: ",arguments),e||(e="");var t={flip:"down",elems:e.elems||alice.anima,rotate:e.rotate||-720,perspectiveOrigin:e.perspectiveOrigin||"top-right",duration:e.duration||"3000ms",timing:e.timing||"ease-in-out",delay:e.delay||"0ms",iteration:e.iteration||1,direction:e.direction||"normal",playstate:e.playstate||"running"};return alice.plugins.cheshire(t),t},alice.plugins.slide=function(e){"use strict";console.info("slide: ",arguments),e||(e="");var t={elems:e.elems||alice.anima,move:e.move||"left",overshoot:e.overshoot||"0",duration:e.duration||"4000ms",timing:e.timing||"ease-in-out",delay:e.delay||"0ms",iteration:e.iteration||1,direction:e.direction||"normal",playstate:e.playstate||"running"};return alice.plugins.cheshire(t),t},alice.plugins.spin=function(e){"use strict";console.info("spin: ",arguments),e||(e="");var t={perspectiveOrigin:"center",direction:"normal",elems:e.elems||alice.anima,flip:e.flip||"left",turns:e.turns||1,overshoot:e.overshoot||0,duration:e.duration||"1200ms",timing:e.timing||"ease-in-out",delay:e.delay||"0ms",iteration:e.iteration||"infinite",playstate:e.playstate||"running"};return alice.plugins.cheshire(t),t},alice.plugins.toss=function(e){"use strict";console.info("toss: ",arguments),e||(e="");var t={rotate:e.move==="left"||e.move==="down"?720:-720,elems:e.elems||alice.anima,move:e.move||"right",overshoot:e.overshoot||0,perspectiveOrigin:e.perspectiveOrigin||"center",duration:e.duration||"2500ms",timing:e.timing||"ease-in-out",delay:e.delay||"0ms",iteration:e.iteration||"infinite",direction:e.direction||"normal",playstate:e.playstate||"running"};return alice.plugins.cheshire(t),t},alice.plugins.twirl=function(e){"use strict";console.info("twirl: ",arguments),e||(e="");var t={rotate:e.flip==="left"?-135:135,elems:e.elems||alice.anima,flip:e.flip||"left",duration:e.duration||"3000ms",timing:e.timing||"ease-in-out",delay:e.delay||"0ms",iteration:e.iteration||1,direction:e.direction||"normal",playstate:e.playstate||"running"};return alice.plugins.cheshire(t),t},alice.plugins.wobble=function(e){"use strict";console.info("wobble: ",arguments),e||(e="");var t={elems:e.elems||alice.anima,rotate:e.rotate||5,perspectiveOrigin:e.perspectiveOrigin||"center",duration:e.duration||"200ms",timing:e.timing||"linear",delay:e.delay||"0ms",iteration:e.iteration||"infinite",direction:"alternate",playstate:e.playstate||"running"};return alice.plugins.cheshire(t),t},alice.plugins.zoom=function(e){"use strict";console.info("zoom: ",arguments),e||(e="");var t={from:"1%",to:"125%"};e.scale&&(typeof e.scale=="object"?t=scale:t.to=scale);var n={elems:e.elems||alice.anima,scale:t,shadow:e.shadow||!0,move:e.move||"none",duration:e.duration||"2000ms",timing:e.timing||"ease",delay:e.delay||"0ms",iteration:e.iteration||1,direction:e.direction||"normal",playstate:e.playstate||"running"};return alice.plugins.cheshire(n),n},alice.plugins.caterpillar=function(){"use strict";var e={pages:[],NewPageClass:"",leftPage:0,rightPage:1,realPageCount:0,pn:1,pageWidth:"",pageHeight:"",docWidth:function(){var e=document.body.clientWidth;return e},docHeight:alice.docHeight(),speed:0,book:"",timing:"linear",binding:"",paging:"",controlBoxStyle:"",wrap:!1,piggyBg:null,transformOrigin:"",transformRotate:"",transformDegrees:[],_rot270:"(262deg)",_rot180:"(180deg)",_rot90:"(90deg)",_rot0:"(0deg)",_rotNeg90:"(-90deg)",_rotNeg180:"(-180deg)",_rotNeg270:"(-262deg)",originZero:"",shadowPattern0:"",shadowPattern50:"",shadowPattern100:"",shadowPatternRev50:"",shadowPatternRev100:"",animationStart:"",animationEnd:"",animationRunning:!1,bookStart:"",bookEnd:"",pageTrigger:"",loadPage:"",jumper:null,pageToClear:"",pageNumber:"",randomizer:"",inPageControls:0,keyControls:0,lastPage:null,helpers:{},AnimGenerator:function(t){var n,r,i,s,o,u,a,f,l="\n	"+alice.prefix+"transform: "+e.transformRotate+e._rot90+";",c="\n	"+alice.prefix+"transform: "+e.transformRotate+e._rot270+";",h="\n	"+alice.prefix+"transform: "+e.transformRotate+e._rotNeg270+";",p="\n	"+alice.prefix+"transform: "+e.transformRotate+e._rotNeg90+";",d="\n	"+alice.prefix+"transform: "+e.transformRotate+e._rot0+";",v="\n	"+alice.prefix+"transform-origin: "+e.originZero+";",m="\n	"+alice.prefix+"transform-origin: 50% 50%;",g="\n	"+alice.prefix+"transform-origin: "+e.transformOrigin+";",y="	0%{"+alice.prefix+"box-shadow:"+t.shadowPattern0+";",b="	50%{"+alice.prefix+"box-shadow:"+t.shadowPattern50+";",w="	100%{"+alice.prefix+"box-shadow:"+t.shadowPattern100+";",E="50%{"+alice.prefix+"box-shadow:"+t.shadowPatternRev50+";"+"\n",S="100%{"+alice.prefix+"box-shadow:"+t.shadowPatternRev100+";"+"\n",x="@"+alice.prefix+"keyframes oddPageTurnF{\n",T="@"+alice.prefix+"keyframes oddPageTurnR{\n",N="@"+alice.prefix+"keyframes evenPageTurnF{\n",C="@"+alice.prefix+"keyframes evenPageTurnR{\n",k="@"+alice.prefix+"keyframes abstrPageTurnF{\n",L="@"+alice.prefix+"keyframes abstrPageTurnR{\n",A="@"+alice.prefix+"keyframes abstrPageReTurnF{\n",O="@"+alice.prefix+"keyframes abstrPageReTurnR{\n",M="}\n";alice.keyframeDelete("oddPageTurnF"),alice.keyframeDelete("oddPageTurnR"),alice.keyframeDelete("evenPageTurnF"),alice.keyframeDelete("evenPageTurnR"),alice.keyframeDelete("abstrPageTurnF"),alice.keyframeDelete("abstrPageTurnR"),alice.keyframeDelete("abstrPageReTurnF"),alice.keyframeDelete("abstrPageReTurnR"),e.paging==="single"&&(e.binding==="left"&&(s=k+y+M+b+M+w+v+h+M+"\n"+M,i=L+y+M+b+M+w+v+d+M+"\n"+M,r=A+y+M+b+M+w+v+d+M+"\n"+M,n=O+y+M+b+M+w+v+d+M+"\n"+M),e.binding==="right"&&(s=k+y+M+b+M+w+g+c+M+"\n"+M,i=L+y+M+b+M+w+g+d+M+"\n"+M,r=A+y+M+b+M+w+g+d+M+"\n"+M,n=O+y+M+b+M+w+g+d+M+"\n"+M),e.binding==="top"&&(s=k+y+M+b+M+w+v+c+M+"\n"+M,i=L+y+M+b+M+w+v+d+M+"\n"+M,r=A+y+M+b+M+w+v+d+M+"\n"+M,n=O+y+M+b+M+w+v+d+M+"\n"+M),e.binding==="bottom"&&(s=k+y+M+b+M+w+g+h+M+"\n"+M,i=L+y+M+b+M+w+g+d+M+"\n"+M,r=A+y+M+b+M+w+g+d+M+"\n"+M,n=O+y+M+b+M+w+g+d+M+"\n"+M),e.binding==="center"&&(s=k+y+M+b+M+w+m+p+M+"\n"+M,i=L+y+M+b+M+w+m+d+M+"\n"+M,r=A+y+M+b+M+w+m+l+M+"\n"+M,n=O+y+M+b+M+w+m+d+M+"\n"+M),e.binding==="middle"&&(s=k+y+M+b+M+w+m+p+M+"\n"+M,i=L+y+M+b+M+w+m+d+M+"\n"+M,r=A+y+M+b+M+w+m+l+M+"\n"+M,n=O+y+M+b+M+w+m+d+M+"\n"+M),alice.keyframeInsert(s),alice.keyframeInsert(i),alice.keyframeInsert(r),alice.keyframeInsert(n)),e.paging==="double"&&(e.binding==="left"&&(o=x+y+M+b+M+w+v+p+M+"\n"+M,u=T+y+M+b+M+w+v+d+M+"\n"+M,a=N+E+M+S+g+d+M+"\n"+M,f=C+E+M+S+g+l+M+"\n"+M),e.binding==="right"&&(o=x+y+M+b+M+w+g+l+M+"\n"+M,u=T+y+M+b+M+w+g+d+M+"\n"+M,a=N+E+M+S+v+d+M+"\n"+M,f=C+E+M+S+v+p+M+"\n"+M),e.binding==="top"&&(o=x+y+M+b+M+w+v+l+M+"\n"+M,u=T+y+M+b+M+w+v+d+M+"\n"+M,a=N+E+M+S+g+d+M+"\n"+M,f=C+E+M+S+g+p+M+"\n"+M),e.binding==="bottom"&&(o=x+y+M+b+M+w+g+p+M+"\n"+M,u=T+y+M+b+M+w+g+d+M+"\n"+M,a=N+E+M+S+v+d+M+"\n"+M,f=C+E+M+S+v+l+M+"\n"+M),alice.keyframeInsert(o),alice.keyframeInsert(u),alice.keyframeInsert(a),alice.keyframeInsert(f))},config:function(t){function n(e){var t=document.styleSheets.length;for(var n=0;n<t;n++){var r=document.styleSheets[n];if(r.rules)var i=r.rules;else var i=r.cssRules;var i=r.cssRules?r.cssRules:r.rules;for(var s=0;s<i.length;s++)if(i[s].selectorText==e){var o=i[s].style.width.toString(),u=i[s].style.height.toString();return[o,u]}}}e.speed=alice.duration(t.speed),e.book=document.getElementById(t.elems||alice.anima),e.timing=t.timing,e.binding=t.binding,e.piggyBg=t.piggyBg,e.controlsBg=t.controlsBg,e.originZero="0 0",e.pageClass=t.pageClass,e.randomizer=t.randomize,console.log(e.randomizer),e.bookStart=document.createEvent("Event"),e.bookStart.initEvent("bookStart",!0,!0),e.bookEnd=document.createEvent("Event"),e.bookEnd.initEvent("bookEnd",!0,!0),e.loadPage=document.createEvent("Event"),e.loadPage.initEvent("loadPage",!0,!0),e.pageTrigger=document.createEvent("Event"),e.pageTrigger.initEvent("pageTrigger",!0,!0);var r,i,s=n("#"+e.book.getAttribute("id"));s?(r=s[0],i=s[1]):(r=e.book.style.width,i=e.book.style.height);var o,u,a;r.indexOf("%")>0?(o="%",u="0."+r.substring(0,r.indexOf(o)),u=parseFloat(u),a=e.docWidth()*u):r.indexOf("px")>0?(o="px",a=r.substring(0,r.indexOf(o))):a=r,e.pageWidth=a;var f,l,c;i.indexOf("%")>0?(f="%",l="0."+i.substring(0,i.indexOf(f)),l=parseFloat(l),c=e.docHeight*l):i.indexOf("px")>0?(f="px",c=i.substring(0,i.indexOf(f))):c=i,e.pageHeight=c;var h=Math.floor(e.pageWidth*4);e.shadowPattern0="",e.shadowPattern50="",e.shadowPattern100="",e.shadowPatternRev50="",e.shadowPatternRev100="",e.wrap=t.wrap,e.paging=t.paging,e.NewPageClass="book"+(new Date).getTime(),e.animationEnd=alice.prefixJS+"AnimationEnd",alice.prefixJS==="Moz"&&(e.animationEnd="animationstart",e.animationEnd="animationend");var p=e.book.childNodes,d=0;for(var v=0;v<p.length;v++)if(p[v].nodeType===1){if(p[v].tagName!=="DIV"&&p[v].tagName!=="div")return console.error("Your pages must be all be the DIV tag element. Please place the contents inside."),!1;e.pages[d]=p[v],e.realPageCount=e.realPageCount+1,d++}e.book.style[alice.prefixJS+"Perspective"]=h+"px",e.book.style.zIndex="1000",e.book.style.position="relative",e.binding=t.binding;if(t.binding==="center"||t.binding==="left"||t.binding==="right")e.transformRotate="rotateY";if(t.binding==="middle"||t.binding==="top"||t.binding==="bottom")e.transformRotate="rotateX";if(t.paging==="single")e.book.style.width=e.pageWidth+"px",e.book.style.height=e.pageHeight+"px";else if(t.paging==="double")if(t.binding==="left"||t.binding==="right")e.book.style.width=e.pageWidth*2+"px",e.book.style.height=e.pageHeight+"px";else if(t.binding==="top"||t.binding==="bottom")e.book.style.width=e.pageWidth+"px",e.book.style.height=e.pageHeight*2+"px";e.controlBoxStyle=e.book;if(e.paging==="single"){e.transformDegrees=[e._rot0,e._rot0,e._rot0];switch(t.binding){case"center":e.transformDegrees=[e._rot0,e._rot90,e._rotNeg90],e.transformOrigin="50% 50%";break;case"middle":e.transformDegrees=[e._rot0,e._rot90,e._rotNeg90],e.transformOrigin="50% 50%";break;case"left":e.transformOrigin=e.originZero;break;case"top":e.transformOrigin=e.originZero;break;case"right":e.transformOrigin=e.pageWidth+"px 0px";break;case"bottom":e.transformDegrees=[e._rot0,e._rot0,e._rotNeg270],e.transformOrigin="0px "+e.pageHeight+"px"}}if(e.paging==="double"){switch(t.binding){case"left":e.transformOrigin=e.pageWidth+"px 0px";break;case"right":e.transformOrigin=e.pageWidth+"px 0px";break;case"top":e.transformOrigin="0px "+e.pageHeight+"px";break;case"bottom":e.transformOrigin="0px "+e.pageHeight+"px"}e.transformDegrees=[e._rot0,e._rot0]}},clearAnimation:function(t,n){var r=e.helper.getThisId(t),i=document.getElementById(t);document.getElementById("_piggy")&&e.book.removeChild(document.getElementById("_piggy")),i.style[alice.prefixJS+"Animation"]="",i.style[alice.prefixJS+"AnimationDelay"]="",i.style[alice.prefixJS+"AnimationDuration"]="",i.style[alice.prefixJS+"AnimationTimingFunction"]="",i.style[alice.prefixJS+"AnimationIterationCount"]="",i.style[alice.prefixJS+"AnimationDirection"]="",i.style[alice.prefixJS+"AnimationPlayState"]="";if(e.binding==="center"||e.binding==="middle")r%2===1&&e.pn%2===1&&(i.style.display="none"),r%2===0&&e.pn%2===1&&(i.style.display="none");else if(e.binding==="left"||e.binding==="top"||e.binding==="right"||e.binding==="bottom")i.style.display="none";if(e.paging==="single"){var s,o;o=document.getElementById("p"+(parseInt(r,10)-1)),s=document.getElementById("p"+(parseInt(r,10)+1)),r===e.realPageCount&&(s=document.getElementById("p1")),i.style[alice.prefixJS+"Transform"]=e.transformRotate+e.transformDegrees[0],i.style.zIndex="0";if(r>1&&n==="forwards"){e.jumper!=null&&(document.getElementById("p"+e.jumper).style.display="block",i.style[alice.prefixJS+"Transform"]=e.transformRotate+e.transformDegrees[1]),o.style[alice.prefixJS+"Transform"]=e.transformRotate+e.transformDegrees[1];if(e.binding==="left"||e.binding==="right"||e.binding==="top"||e.binding==="bottom")s.style[alice.prefixJS+"Transform"]=e.transformRotate+e.transformDegrees[0]}r===1&&n==="forwards"&&(o=document.getElementById("p"+e.realPageCount),o.style[alice.prefixJS+"Transform"]=e.transformRotate+e.transformDegrees[1]);if(r>0&&n==="reverse"){o=document.getElementById("p"+(r-1)),e.jumper!=null&&(document.getElementById("p"+e.jumper).style.display="block",i.style[alice.prefixJS+"Transform"]=e.transformRotate+e.transformDegrees[1]),e.wrap===!0&&r!==e.realPageCount&&(s=document.getElementById("p"+(parseInt(r,10)+1)));if(e.binding==="left"||e.binding==="top"||e.binding==="right"||e.binding==="bottom")s.style.display="none",i.style.display="block",e.jumper!=null&&(document.getElementById("p"+e.jumper).style.display="none");s.style[alice.prefixJS+"Transform"]=e.transformRotate+e.transformDegrees[1]}r===1&&n==="reverse"&&(o=document.getElementById("p"+e.realPageCount),o.style[alice.prefixJS+"Transform"]=e.transformRotate+e.transformDegrees[2],s.style[alice.prefixJS+"Transform"]=e.transformRotate+e.transformDegrees[1])}e.pn++,e.jumper=null},resetCSS:function(t,n,r){var i,s,o,u,a,f;i=document.getElementById(r),s=e.helper.getThisId(r),o=document.getElementById("p"+(parseInt(s,10)+1)),u="display: block; left: 0px; top: 0px;";if(s%2===1){i.setAttribute("style","");if(t==="forward"){i.style[alice.prefixJS+"TransformOrigin"]=e.originZero;switch(e.binding){case"top":a=e.transformRotate+e._rot90,i.style.top=e.pageHeight+"px";break;case"right":a=e.transformRotate+e._rot90,i.style[alice.prefixJS+"TransformOrigin"]=e.transformOrigin;break;case"left":a=e.transformRotate+e._rotNeg90,i.style.left=e.pageWidth+"px";break;case"bottom":a=e.transformRotate+
e._rotNeg90,i.style[alice.prefixJS+"TransformOrigin"]=e.transformOrigin}i.style[alice.prefixJS+"Transform"]=a}else if(t==="reverse"){i.setAttribute("style",u),i.style[alice.prefixJS+"TransformOrigin"]=e.originZero;switch(e.binding){case"top":i.style.top=e.pageHeight+"px";break;case"right":i.style[alice.prefixJS+"TransformOrigin"]=e.transformOrigin;break;case"left":i.style.left=e.pageWidth+"px";break;case"bottom":i.style[alice.prefixJS+"TransformOrigin"]=e.transformOrigin;break;default:i.style.top="0px"}}}if(s%2===0){i.setAttribute("style","");if(t==="forward"){i.setAttribute("style",u),i.style[alice.prefixJS+"TransformOrigin"]=e.originZero;switch(e.binding){case"top":i.style[alice.prefixJS+"TransformOrigin"]=e.transformOrigin;break;case"right":i.style.left=e.pageWidth+"px";break;case"left":i.style[alice.prefixJS+"TransformOrigin"]=e.transformOrigin,i.style.left="0px";break;case"bottom":i.style[alice.prefixJS+"TransformOrigin"]=e.originZero,i.style.top=e.pageHeight+"px"}i.style[alice.prefixJS+"Transform"]=e.transformRotate+e._rot0}else if(t==="reverse"){i.style[alice.prefixJS+"TransformOrigin"]=e.originZero;switch(e.binding){case"top":i.style[alice.prefixJS+"TransformOrigin"]=e.transformOrigin,f=e.transformRotate+e._rotNeg90;break;case"right":f=e.transformRotate+e._rotNeg90,i.style.left=e.pageWidth+"px";break;case"bottom":f=e.transformRotate+e._rot90,i.style.top=e.pageHeight+"px";break;case"left":i.style[alice.prefixJS+"TransformOrigin"]=e.transformOrigin,f=e.transformRotate+e._rot90}i.style[alice.prefixJS+"Transform"]=f}}i.style.border="none",i.style[alice.prefixJS+"boxShadow"]=e.shadowPattern0},styleConfig:function(t){var n=document.getElementById("p"+t);e.paging==="single"&&((e.binding==="center"||e.binding==="middle")&&n.setAttribute("style","display: none; "+alice.prefix+"transform-origin: 50% 50%;"+alice.prefix+"transform: "+e.transformRotate+e._rot90+";"+alice.prefix+"box-shadow: "+e.shadowPattern100+";"),(e.binding==="left"||e.binding==="top"||e.binding==="bottom"||e.binding==="right")&&n.setAttribute("style","display: none; "+alice.prefix+"transform-origin:"+e.transformOrigin+";"+alice.prefix+"transform: "+e.transformRotate+e._rot0+";"+alice.prefix+"box-shadow: "+e.shadowPattern100+";")),e.paging==="double"&&(e.binding==="left"&&(t%2===1&&(n.style[alice.prefixJS+"TransformOrigin"]=e.originZero,n.style.left=e.pageWidth+"px"),t%2===0&&(n.style[alice.prefixJS+"TransformOrigin"]=e.transformOrigin,n.style[alice.prefixJS+"Transform"]=e.transformRotate+e._rot90)),e.binding==="right"&&(t%2===1&&(n.style[alice.prefixJS+"TransformOrigin"]=e.transformOrigin),t%2===0&&(n.style[alice.prefixJS+"TransformOrigin"]=e.originZero,n.style.left=e.pageWidth+"px",n.style[alice.prefixJS+"Transform"]=e.transformRotate+e._rotNeg90)),e.binding==="top"&&(t%2===1&&(n.style.top=e.pageHeight+"px",n.style[alice.prefixJS+"TransformOrigin"]=e.originZero),t%2===0&&(n.style[alice.prefixJS+"TransformOrigin"]=e.transformOrigin,n.style[alice.prefixJS+"Transform"]=e.transformRotate+e._rotNeg90)),e.binding==="bottom"&&(t%2===1&&(n.style[alice.prefixJS+"TransformOrigin"]=e.transformOrigin),t%2===0&&(n.style[alice.prefixJS+"TransformOrigin"]=e.originZero,n.style.top=e.pageHeight+"px",n.style[alice.prefixJS+"Transform"]=e.transformRotate+e._rot90)))},init:function(t){function r(t){var n=t.keyCode,r=e.realPageCount+1;n===39&&e.rightPage<=r&&(e.paging==="single"&&e.abPageTurn(e.rightPage),e.paging==="double"&&e.turnPage(e.rightPage)),n===37&&(e.paging==="single"&&e.abPageTurnR(e.rightPage),e.paging==="double"&&e.leftPage>=1&&e.turnPage(e.leftPage))}e.config(t),e.AnimGenerator(t),e.binding!=="center"||e.binding!=="middle"?e.helper.bookStatus(e.rightPage-1):e.helper.bookStatus(e.rightPage),t.inPageControls===!1&&(e.inPageControls=1),t.keyControls===!1&&(e.keyControls=1);var n=function(t){var n=document.createElement("div");n.setAttribute("id","_"+t+"Controller"),n.style.width="80px",n.style.height=e.pageHeight+"px",n.style.position="absolute",n.style.background=e.controlsBg||"#999",n.style.opacity="0.3",n.style.zIndex="0",n.style.top=e.controlBoxStyle.offsetTop+"px";var r="alice.plugins.caterpillar";t==="right"?(n.style.left=e.controlBoxStyle.offsetLeft+parseInt(e.pageWidth,10)+"px",n.style.borderTopRightRadius="100px",n.style.borderBottomRightRadius="100px",n.setAttribute("onclick",r+".abPageTurn("+r+".rightPage)")):(n.style.left=e.controlBoxStyle.offsetLeft-parseInt(n.style.width,10)+"px",n.style.borderTopLeftRadius="100px",n.style.borderBottomLeftRadius="100px",n.setAttribute("onclick",r+".abPageTurnR("+r+".rightPage)")),document.body.appendChild(n)};t.controls===!0&&t.paging==="single"&&(n("left"),n("right"),window.onresize=function(e){document.body.removeChild(document.getElementById("_leftController")),document.body.removeChild(document.getElementById("_rightController")),n("left"),n("right")}),e.keyControls===0&&document.body.addEventListener("keyup",r,!1),e.pageBuilder(t)},nxtPage:function(){var t=e.realPageCount+1;e.rightPage<=t&&(e.paging==="single"&&e.abPageTurn(e.rightPage),e.paging==="double"&&e.turnPage(e.rightPage))},prePage:function(){var t=e.realPageCount+1;e.paging==="single"&&e.abPageTurnR(e.rightPage),e.paging==="double"&&e.leftPage>=1&&e.turnPage(e.leftPage)},pageBuilder:function(t){var n=e.pages[0].getAttribute("class"),r=n+" "+e.pageClass,i="."+e.NewPageClass+"{ display: none; "+alice.prefix+"box-shadow: "+e.shadowPattern100+";"+alice.prefix+"backface-visibility: hidden;"+"width: "+e.pageWidth+"px;"+"height: "+e.pageHeight+"px;"+"position: absolute;"+"border: none;"+"left: 0px;"+"top: 0px;"+"z-index: 0;"+"overflow: hidden;"+"}";alice.keyframeInsert(i);if(e.paging==="single"){var s=1;for(var o=0;o<e.pages.length;o++)e.pages[o].setAttribute("id","p"+s),e.pages[o].setAttribute("class",r+" "+e.NewPageClass),e.pages[o].addEventListener(e.animationEnd,function(){if(this.style[alice.prefixJS+"AnimationName"]==="abstrPageTurnF"){var t=this.getAttribute("id");e.binding==="center"||e.binding==="middle"?alice.plugins.caterpillar.abstrPageFlip(this.getAttribute("id"),"forwards",e.jumper,"forwards"):e.helper.bookStatus(e.helper.getThisId(t)),e.rightPage===e.realPageCount&&e.wrap===!0&&(t=e.realPageCount,e.rightPage=0),e.clearAnimation(this.getAttribute("id"),"forwards"),e.rightPage++,e.binding!=="center"&&e.binding!=="middle"&&(e.animationRunning=!1)}this.style[alice.prefixJS+"AnimationName"]==="abstrPageReTurnF"&&((e.binding==="center"||e.binding==="middle")&&alice.plugins.caterpillar.abstrPageFlip(this.getAttribute("id"),"reverse",e.jumper,"reverse"),e.clearAnimation(e.pageToClear,"reverse"),e.rightPage--,e.binding!=="center"&&e.binding!=="middle"&&(e.animationRunning=!1))},!1),t.controls!==!0&&e.inPageControls===0&&e.pages[o].setAttribute("onclick","alice.plugins.caterpillar.abPageTurn("+s+")"),e.styleConfig(s),s===1&&(e.pages[o].style.display="block",e.pages[o].setAttribute("style","display: block; z-index: 1;"+alice.prefix+"transform-origin:"+e.transformOrigin+";"+alice.prefix+"transform: "+e.transformRotate+e._rot0+";"+alice.prefix+"box-shadow: "+e.shadowPatternRev100+";")),s++}if(e.paging==="double"){var u=1;for(var a=0;a<e.pages.length;a++)e.pages[a].nodeType===1&&(e.pages[a].setAttribute("id","p"+u),e.pages[a].setAttribute("class",r+" "+e.NewPageClass),u===1&&(e.pages[a].style.display="block",e.pages[a].style[alice.prefixJS+"BoxShadow"]=e.shadowPattern100+";"),e.styleConfig(u),e.inPageControls===0&&e.pages[a].setAttribute("onclick","alice.plugins.caterpillar.turnPage("+u+")"),e.pages[a].addEventListener(e.animationEnd,function(){this.style[alice.prefixJS+"AnimationName"]==="oddPageTurnF"&&(e.turnNextPage(this.getAttribute("id"),"odd"),e.resetCSS("forward",e.binding,this.getAttribute("id")));if(this.style[alice.prefixJS+"AnimationName"]==="oddPageTurnR"){e.resetCSS("reverse",e.binding,this.getAttribute("id"));var t=e.helper.getThisId(this.getAttribute("id"));t=parseInt(t,10)+2,t<e.realPageCount+1&&(document.getElementById("p"+t).style.display="none"),e.animationRunning=!1}this.style[alice.prefixJS+"AnimationName"]==="evenPageTurnF"&&(e.resetCSS("forward",e.binding,this.getAttribute("id")),e.animationRunning=!1),this.style[alice.prefixJS+"AnimationName"]==="evenPageTurnR"&&(e.turnNextPage(this.getAttribute("id"),"even"),e.resetCSS("reverse",e.binding,this.getAttribute("id")))},!1),u++)}return e},goToPage:function(t){e.paging==="single"&&e.abPageTurn(e.rightPage,t)},revToPage:function(t){e.paging==="single"&&e.abPageTurnR(e.rightPage,t)},abstrPageFlip:function(t,n,r,i){var s,o;n==="forwards"?(s=e.helper.getThisId(t)+1,o="abstrPageTurnR",s===e.realPageCount+1&&(s=1),r&&i==="forwards"&&(s=r,e.rightPage=r-1)):n==="reverse"&&(o="abstrPageReTurnR",s=e.helper.getThisId(t)-1,s===0&&(s=e.realPageCount),r&&i==="reverse"&&(s=r,e.rightPage=r+1));var u=e.book.querySelector("div:nth-child("+s+")").getAttribute("id"),a=document.getElementById(u);a.style[alice.prefixJS+"AnimationName"]=o,e.helper.setAnimDefaults(a),a.addEventListener(e.animationEnd,function(){a.style[alice.prefixJS+"AnimationName"]===o&&(e.clearAnimation("p"+s,n),e.animationRunning=!1)},!1),r?e.helper.bookStatus(r):e.helper.bookStatus(s)},turnNextPage:function(t,n){var r,i,s,o;r=e.helper.getThisId(t),r=n==="odd"?r+1:r-1,o=n==="even"?"oddPageTurnR":"evenPageTurnF",e.helper.bookStatus(r),e.animationRunning=!0,i=e.book.querySelector("div:nth-child("+r+")").getAttribute("id"),s=document.getElementById(i),s.style.zIndex=1,n==="odd"&&(s.style.display="block"),s.style[alice.prefixJS+"AnimationName"]=o,e.helper.setAnimDefaults(s)},turnPage:function(t){e.helper.bookStatus(t);if(e.animationRunning===!1){e.lastPage=t;var n,r,i,s;e.realPageCount%2===0?s=e.realPageCount+1:s=e.realPageCount,e.leftPage<0&&(e.leftPage=0,e.rightPage=1),e.rightPage>e.realPageCount&&(e.leftPage=e.realPageCount,e.rightPage=e.realPageCount+1),t%2===1?(n=t+1,r=t+2,i="oddPageTurnF"):(n=t-1,r=t-2,i="evenPageTurnR");if(t<s){e.animationRunning=!0;var o=e.book.querySelector("div:nth-child("+r+")");if(o){o=o.getAttribute("id");var u=document.getElementById(o);u.style.zIndex="0",u.style.display="block"}var a=document.getElementById("p"+t);a.style.zIndex="1",a.style[alice.prefixJS+"AnimationName"]=i,e.helper.setAnimDefaults(a),t%2===1?e.rightPage<e.realPageCount+1&&(e.rightPage+=2,e.leftPage+=2):e.leftPage>=1&&(e.rightPage-=2,e.leftPage-=2)}}},abPageTurn:function(t,n){e.lastPage=t;if(e.animationRunning===!1){t>=e.realPageCount&&e.wrap===!0&&(t=0),t===0&&e.wrap===!0&&(e.binding==="center"||e.binding==="middle")&&(t=e.realPageCount,e.rightPage=e.realPageCount);var r=document.getElementById("p"+e.rightPage);if(!n)try{var i=e.book.querySelector("div:nth-child("+(t+1)+")").getAttribute("id"),s=document.getElementById(i);s.style.display="block"}catch(o){if(e.wrap!==!0)return console.log("This is the end of the book!"),!1}else{e.jumper=n;var i=e.book.querySelector("div:nth-child("+e.jumper+")").getAttribute("id"),s=document.getElementById(i);s.style.display="block",e.rightPage=n-1}r.style.zIndex="100",r.style[alice.prefixJS+"AnimationName"]="abstrPageTurnF",e.animationRunning=!0,e.helper.setAnimDefaults(r),e.binding!=="center"&&e.binding!=="middle"&&e.helper.piggyback(t,"standard")}},abPageTurnR:function(t,n){var r;e.lastPage=t;if(e.animationRunning===!1){n>0&&(e.lastPage=n);if(e.binding==="center"||e.binding==="middle"){t>=e.realPageCount&&(t=e.realPageCount,e.rightPage=e.realPageCount);if(e.rightPage===0||t===0)e.rightPage=e.realPageCount,t=e.realPageCount;t!==1&&e.helper.pageSetter(t),e.wrap===!1&&t===1&&(t=-1),t>=0&&(r=document.getElementById("p"+e.rightPage),r.style[alice.prefixJS+"AnimationName"]="abstrPageReTurnF",e.pageToClear=r.getAttribute("id")),n&&(e.helper.pageSetter(n+1),e.jumper=n)}if(e.binding==="left"||e.binding==="right"||e.binding==="top"||e.binding==="bottom"){n&&(e.jumper=t,t=n+1,e.rightPage=n+1),e.wrap===!0&&t-1===0&&(t=e.realPageCount+1,e.rightPage=e.realPageCount+1),e.wrap===!1&&t>=e.realPageCount&&(t=e.realPageCount),r=document.getElementById("p"+(t-1)),r.style.zIndex="10";switch(e.binding){case"left":r.style[alice.prefixJS+"Transform"]=e.transformRotate+e._rotNeg270;break;case"bottom":r.style[alice.prefixJS+"Transform"]=e.transformRotate+e._rotNeg270;break;case"top":r.style[alice.prefixJS+"Transform"]=e.transformRotate+e._rot270;break;case"right":r.style[alice.prefixJS+"Transform"]=e.transformRotate+e._rot270}r.style[alice.prefixJS+"AnimationName"]="abstrPageReTurnF",e.pageToClear="p"+(t-1),e.helper.bookStatus(t-2)}e.animationRunning=!0,e.helper.setAnimDefaults(r),e.binding!=="center"&&e.binding!=="middle"&&e.helper.piggyback(t-1,"advanced")}},loadMorePages:function(t,n){var r=alice.plugins.caterpillar,i,s,o,u,a,f,l;r.animationRunning=!1,i=new XMLHttpRequest,i.open("GET",t,!0),i.onreadystatechange=function(){if(i.readyState==4){s=i.responseText,o=document.getElementById(n),u=document.getElementById(n).childNodes,a=o.parentNode,l=e.realPageCount;var t=document.createElement("div");t.setAttribute("id","___xbook"),t.innerHTML=s;var c=t.childNodes,h=0,p=[];for(var d=0;d<c.length;d++)c[d].nodeType===1&&(c[d].tagName==="DIV"||c[d].tagName==="div")&&(p[h]=c[d],r.realPageCount=r.realPageCount+1,h++);var v=e.pages[1].getAttribute("class"),m=e.pages[1].getAttribute("style"),g=e.pages[2].getAttribute("style"),y=1;for(f=0;f<p.length;f++){var b=l+y;p[f].setAttribute("class",v),p[f].setAttribute("style",m),p[f].setAttribute("id","p"+b),o.appendChild(p[f]),e.paging==="single"?(e.inPageControls===!0&&p[f].setAttribute("onclick","alice.plugins.caterpillar.abPageTurn("+b+")"),p[f].addEventListener(e.animationEnd,function(){if(this.style[alice.prefixJS+"AnimationName"]==="abstrPageTurnF"){var t=this.getAttribute("id");e.binding==="center"||e.binding==="middle"?alice.plugins.caterpillar.abstrPageFlip(this.getAttribute("id"),"forwards",e.jumper,"forwards"):e.helper.bookStatus(e.helper.getThisId(t)),e.rightPage===e.realPageCount&&e.wrap===!0&&(t=e.realPageCount,e.rightPage=0),e.clearAnimation(this.getAttribute("id"),"forwards"),e.rightPage++,e.binding!=="center"&&e.binding!=="middle"&&(e.animationRunning=!1)}this.style[alice.prefixJS+"AnimationName"]==="abstrPageReTurnF"&&((e.binding==="center"||e.binding==="middle")&&alice.plugins.caterpillar.abstrPageFlip(this.getAttribute("id"),"reverse",e.jumper,"reverse"),e.clearAnimation(e.pageToClear,"reverse"),e.rightPage--,e.binding!=="center"&&e.binding!=="middle"&&(e.animationRunning=!1))},!1)):e.paging==="double"&&(e.inPageControls===!0&&p[f].setAttribute("onclick","alice.plugins.caterpillar.turnPage("+b+")"),p[f].addEventListener(e.animationEnd,function(){this.style[alice.prefixJS+"AnimationName"]==="oddPageTurnF"&&(e.turnNextPage(this.getAttribute("id"),"odd"),e.resetCSS("forward",e.binding,this.getAttribute("id")));if(this.style[alice.prefixJS+"AnimationName"]==="oddPageTurnR"){e.resetCSS("reverse",e.binding,this.getAttribute("id"));var t=e.helper.getThisId(this.getAttribute("id"));t=parseInt(t,10)+2,t<e.realPageCount+1&&(document.getElementById("p"+t).style.display="none"),e.animationRunning=!1}this.style[alice.prefixJS+"AnimationName"]==="evenPageTurnF"&&(e.resetCSS("forward",e.binding,this.getAttribute("id")),e.animationRunning=!1),this.style[alice.prefixJS+"AnimationName"]==="evenPageTurnR"&&(e.turnNextPage(this.getAttribute("id"),"even"),e.resetCSS("reverse",e.binding,this.getAttribute("id")))},!1)),e.paging==="double"&&(e.styleConfig(l+y),document.getElementById("p"+b).style.display="none"),y++}}},i.send(null)},loadNewBook:function(e,t){var n=alice.plugins.caterpillar,r,i,s,o,u,a;n.animationRunning=!1,r=new XMLHttpRequest,r.open("GET",e,!0),r.onreadystatechange=function(){if(r.readyState==4){i=r.responseText,s=document.getElementById("book"),o=document.getElementById("book").childNodes,u=s.parentNode,document.getElementById("_leftController")&&(document.body.removeChild(document.getElementById("_leftController")),document.body.removeChild(document.getElementById("_rightController")));var e=document.createElement("div");e.setAttribute("id","__xbook"),e.innerHTML=i;var f=e.childNodes,l=0,c=[];for(var h=0;h<f.length;h++)f[h].nodeType===1&&(f[h].tagName==="DIV"||f[h].tagName==="div")&&(c[l]=f[h],n.realPageCount=n.realPageCount+1,l++);n.pages="",s.innerHTML="",n.realPageCount=0;var p=c;for(a=0;a<p.length;a++)p[a].removeAttribute("style"),p[a].removeAttribute("id"),s.appendChild(p[a]);n.pages=p,alice.plugins.caterpillar.rightPage=1,alice.plugins.caterpillar.leftPage=0,new t,console.log(n.realPageCount)}},r.send(null)}};return e}();var _caterpillar=alice.plugins.caterpillar;alice.plugins.caterpillar.helper={bookStatus:function(e){"use strict";(_caterpillar.binding==="center"||_caterpillar.binding==="middle")&&e===0&&(e=1),_caterpillar.binding!=="center"&&_caterpillar.binding!=="middle"&&_caterpillar.paging!=="double"&&(e+=1);var t="page: "+e;_caterpillar.pageNumber=e,document.dispatchEvent(_caterpillar.pageTrigger),e===1&&(t="This is the first page",document.dispatchEvent(_caterpillar.bookStart));if(e===_caterpillar.realPageCount||e===0)_caterpillar.paging==="single"?t="This is the end of the book":t="This is the first page";console.log(t),e===_caterpillar.realPageCount&&document.dispatchEvent(_caterpillar.bookEnd)},getThisId:function(e){"use strict";var t=e.substring(1,8);return t=parseInt(t,10),t},pageSetter:function(e){"use strict";e===0&&(e=_caterpillar.realPageCount);var t="p"+(e-1),n=document.getElementById(t);n.style[alice.prefixJS+"Transform"]=_caterpillar.transformRotate+_caterpillar._rotNeg90},setAnimDefaults:function(e,t){"use strict";var n;t?n=t:n=alice.randomize(_caterpillar.speed,_caterpillar.randomizer)+"ms",e.style[alice.prefixJS+"AnimationDuration"]=n,e.style[alice.prefixJS+"AnimationFillMode"]="forwards",e.style[alice.prefixJS+"AnimationPlayState"]="running",e.style[alice.prefixJS+"AnimationDirection"]="normal",e.style[alice.prefixJS+"AnimationTimingFunction"]="linear",e.style.display="block"},piggyback:function(e,t){"use strict";e===0&&(e=_caterpillar.realPageCount);var n=document.getElementById("p"+e).style[alice.prefixJS+"AnimationDuration"],r=t==="standard"?"abstrPageTurnF":"abstrPageReTurnF",i="0",s=document.createElement("div");s.setAttribute("id","_piggy"),s.style.width=_caterpillar.pageWidth+"px",s.style.height=_caterpillar.pageHeight+"px",s.style.position="absolute",s.style.background=_caterpillar.piggyBg||"#222",s.style.top="0px",s.style.left="0px";if(t==="advanced"){var o;switch(_caterpillar.binding){case"left":o=_caterpillar._rotNeg270;break;case"bottom":o=_caterpillar._rotNeg270;break;case"top":o=_caterpillar._rot270;break;case"right":o=_caterpillar._rot270}s.style[alice.prefixJS+"Transform"]=_caterpillar.transformRotate+o}s.style.zIndex=i,s.style[alice.prefixJS+"AnimationName"]=r,s.style[alice.prefixJS+"TransformOrigin"]=_caterpillar.transformOrigin,_caterpillar.helper.setAnimDefaults(s,n),_caterpillar.book.appendChild(s)}},alice.plugins.book=function(e){"use strict";console.info("book: ",arguments),e||(e="");var t={elems:e.elems||alice.anima,pageClass:e.pageClass||"",bookWidth:e.bookWidth||document.getElementById(e.elems||alice.anima).style.width,bookHeight:e.bookHeight||document.getElementById(e.elems||alice.anima).style.height,shadow:e.shadow||!0,speed:e.speed||"500ms",inPageControls:e.inPageControls,keyControls:e.keyControls,randomize:e.randomize||"15%",binding:e.binding||"vertical",paging:e.paging||"single",wrap:e.wrap||!1,controls:e.controls||!1,piggyBg:e.pageBackground||"#222",controlsBg:e.controlBackground||"#999"};return console.log(t),alice.plugins.caterpillar.init(t),t};
define("alice", function(){});

/**
 * @license RequireJS text 2.0.3 Copyright (c) 2010-2012, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/requirejs/text for details
 */
/*jslint regexp: true */
/*global require: false, XMLHttpRequest: false, ActiveXObject: false,
  define: false, window: false, process: false, Packages: false,
  java: false, location: false */

define('text',['module'], function (module) {
    'use strict';

    var text, fs,
        progIds = ['Msxml2.XMLHTTP', 'Microsoft.XMLHTTP', 'Msxml2.XMLHTTP.4.0'],
        xmlRegExp = /^\s*<\?xml(\s)+version=[\'\"](\d)*.(\d)*[\'\"](\s)*\?>/im,
        bodyRegExp = /<body[^>]*>\s*([\s\S]+)\s*<\/body>/im,
        hasLocation = typeof location !== 'undefined' && location.href,
        defaultProtocol = hasLocation && location.protocol && location.protocol.replace(/\:/, ''),
        defaultHostName = hasLocation && location.hostname,
        defaultPort = hasLocation && (location.port || undefined),
        buildMap = [],
        masterConfig = (module.config && module.config()) || {};

    text = {
        version: '2.0.3',

        strip: function (content) {
            //Strips <?xml ...?> declarations so that external SVG and XML
            //documents can be added to a document without worry. Also, if the string
            //is an HTML document, only the part inside the body tag is returned.
            if (content) {
                content = content.replace(xmlRegExp, "");
                var matches = content.match(bodyRegExp);
                if (matches) {
                    content = matches[1];
                }
            } else {
                content = "";
            }
            return content;
        },

        jsEscape: function (content) {
            return content.replace(/(['\\])/g, '\\$1')
                .replace(/[\f]/g, "\\f")
                .replace(/[\b]/g, "\\b")
                .replace(/[\n]/g, "\\n")
                .replace(/[\t]/g, "\\t")
                .replace(/[\r]/g, "\\r")
                .replace(/[\u2028]/g, "\\u2028")
                .replace(/[\u2029]/g, "\\u2029");
        },

        createXhr: masterConfig.createXhr || function () {
            //Would love to dump the ActiveX crap in here. Need IE 6 to die first.
            var xhr, i, progId;
            if (typeof XMLHttpRequest !== "undefined") {
                return new XMLHttpRequest();
            } else if (typeof ActiveXObject !== "undefined") {
                for (i = 0; i < 3; i += 1) {
                    progId = progIds[i];
                    try {
                        xhr = new ActiveXObject(progId);
                    } catch (e) {}

                    if (xhr) {
                        progIds = [progId];  // so faster next time
                        break;
                    }
                }
            }

            return xhr;
        },

        /**
         * Parses a resource name into its component parts. Resource names
         * look like: module/name.ext!strip, where the !strip part is
         * optional.
         * @param {String} name the resource name
         * @returns {Object} with properties "moduleName", "ext" and "strip"
         * where strip is a boolean.
         */
        parseName: function (name) {
            var strip = false, index = name.indexOf("."),
                modName = name.substring(0, index),
                ext = name.substring(index + 1, name.length);

            index = ext.indexOf("!");
            if (index !== -1) {
                //Pull off the strip arg.
                strip = ext.substring(index + 1, ext.length);
                strip = strip === "strip";
                ext = ext.substring(0, index);
            }

            return {
                moduleName: modName,
                ext: ext,
                strip: strip
            };
        },

        xdRegExp: /^((\w+)\:)?\/\/([^\/\\]+)/,

        /**
         * Is an URL on another domain. Only works for browser use, returns
         * false in non-browser environments. Only used to know if an
         * optimized .js version of a text resource should be loaded
         * instead.
         * @param {String} url
         * @returns Boolean
         */
        useXhr: function (url, protocol, hostname, port) {
            var uProtocol, uHostName, uPort,
                match = text.xdRegExp.exec(url);
            if (!match) {
                return true;
            }
            uProtocol = match[2];
            uHostName = match[3];

            uHostName = uHostName.split(':');
            uPort = uHostName[1];
            uHostName = uHostName[0];

            return (!uProtocol || uProtocol === protocol) &&
                   (!uHostName || uHostName.toLowerCase() === hostname.toLowerCase()) &&
                   ((!uPort && !uHostName) || uPort === port);
        },

        finishLoad: function (name, strip, content, onLoad) {
            content = strip ? text.strip(content) : content;
            if (masterConfig.isBuild) {
                buildMap[name] = content;
            }
            onLoad(content);
        },

        load: function (name, req, onLoad, config) {
            //Name has format: some.module.filext!strip
            //The strip part is optional.
            //if strip is present, then that means only get the string contents
            //inside a body tag in an HTML string. For XML/SVG content it means
            //removing the <?xml ...?> declarations so the content can be inserted
            //into the current doc without problems.

            // Do not bother with the work if a build and text will
            // not be inlined.
            if (config.isBuild && !config.inlineText) {
                onLoad();
                return;
            }

            masterConfig.isBuild = config.isBuild;

            var parsed = text.parseName(name),
                nonStripName = parsed.moduleName + '.' + parsed.ext,
                url = req.toUrl(nonStripName),
                useXhr = (masterConfig.useXhr) ||
                         text.useXhr;

            //Load the text. Use XHR if possible and in a browser.
            if (!hasLocation || useXhr(url, defaultProtocol, defaultHostName, defaultPort)) {
                text.get(url, function (content) {
                    text.finishLoad(name, parsed.strip, content, onLoad);
                }, function (err) {
                    if (onLoad.error) {
                        onLoad.error(err);
                    }
                });
            } else {
                //Need to fetch the resource across domains. Assume
                //the resource has been optimized into a JS module. Fetch
                //by the module name + extension, but do not include the
                //!strip part to avoid file system issues.
                req([nonStripName], function (content) {
                    text.finishLoad(parsed.moduleName + '.' + parsed.ext,
                                    parsed.strip, content, onLoad);
                });
            }
        },

        write: function (pluginName, moduleName, write, config) {
            if (buildMap.hasOwnProperty(moduleName)) {
                var content = text.jsEscape(buildMap[moduleName]);
                write.asModule(pluginName + "!" + moduleName,
                               "define(function () { return '" +
                                   content +
                               "';});\n");
            }
        },

        writeFile: function (pluginName, moduleName, req, write, config) {
            var parsed = text.parseName(moduleName),
                nonStripName = parsed.moduleName + '.' + parsed.ext,
                //Use a '.js' file name so that it indicates it is a
                //script that can be loaded across domains.
                fileName = req.toUrl(parsed.moduleName + '.' +
                                     parsed.ext) + '.js';

            //Leverage own load() method to load plugin value, but only
            //write out values that do not have the strip argument,
            //to avoid any potential issues with ! in file names.
            text.load(nonStripName, req, function (value) {
                //Use own write() method to construct full module value.
                //But need to create shell that translates writeFile's
                //write() to the right interface.
                var textWrite = function (contents) {
                    return write(fileName, contents);
                };
                textWrite.asModule = function (moduleName, contents) {
                    return write.asModule(moduleName, fileName, contents);
                };

                text.write(pluginName, nonStripName, textWrite, config);
            }, config);
        }
    };

    if (masterConfig.env === 'node' || (!masterConfig.env &&
            typeof process !== "undefined" &&
            process.versions &&
            !!process.versions.node)) {
        //Using special require.nodeRequire, something added by r.js.
        fs = require.nodeRequire('fs');

        text.get = function (url, callback) {
            var file = fs.readFileSync(url, 'utf8');
            //Remove BOM (Byte Mark Order) from utf8 files if it is there.
            if (file.indexOf('\uFEFF') === 0) {
                file = file.substring(1);
            }
            callback(file);
        };
    } else if (masterConfig.env === 'xhr' || (!masterConfig.env &&
            text.createXhr())) {
        text.get = function (url, callback, errback) {
            var xhr = text.createXhr();
            xhr.open('GET', url, true);

            //Allow overrides specified in config
            if (masterConfig.onXhr) {
                masterConfig.onXhr(xhr, url);
            }

            xhr.onreadystatechange = function (evt) {
                var status, err;
                //Do not explicitly handle errors, those should be
                //visible via console output in the browser.
                if (xhr.readyState === 4) {
                    status = xhr.status;
                    if (status > 399 && status < 600) {
                        //An http 4xx or 5xx error. Signal an error.
                        err = new Error(url + ' HTTP status: ' + status);
                        err.xhr = xhr;
                        errback(err);
                    } else {
                        callback(xhr.responseText);
                    }
                }
            };
            xhr.send(null);
        };
    } else if (masterConfig.env === 'rhino' || (!masterConfig.env &&
            typeof Packages !== 'undefined' && typeof java !== 'undefined')) {
        //Why Java, why is this so awkward?
        text.get = function (url, callback) {
            var stringBuffer, line,
                encoding = "utf-8",
                file = new java.io.File(url),
                lineSeparator = java.lang.System.getProperty("line.separator"),
                input = new java.io.BufferedReader(new java.io.InputStreamReader(new java.io.FileInputStream(file), encoding)),
                content = '';
            try {
                stringBuffer = new java.lang.StringBuffer();
                line = input.readLine();

                // Byte Order Mark (BOM) - The Unicode Standard, version 3.0, page 324
                // http://www.unicode.org/faq/utf_bom.html

                // Note that when we use utf-8, the BOM should appear as "EF BB BF", but it doesn't due to this bug in the JDK:
                // http://bugs.sun.com/bugdatabase/view_bug.do?bug_id=4508058
                if (line && line.length() && line.charAt(0) === 0xfeff) {
                    // Eat the BOM, since we've already found the encoding on this file,
                    // and we plan to concatenating this buffer with others; the BOM should
                    // only appear at the top of a file.
                    line = line.substring(1);
                }

                stringBuffer.append(line);

                while ((line = input.readLine()) !== null) {
                    stringBuffer.append(lineSeparator);
                    stringBuffer.append(line);
                }
                //Make sure we return a JavaScript string and not a Java string.
                content = String(stringBuffer.toString()); //String
            } finally {
                input.close();
            }
            callback(content);
        };
    }

    return text;
});


define('index', [
        'mustache',
        'alice',
        'text'], (function(mustache, alice){

    var appData;

    var bindEvents = function() {

        if (navigator.userAgent.match(/(iPhone|iPod|iPad|Android|BlackBerry)/)) {

            document.addEventListener("deviceready", onDeviceReady, false);

        } else {

            onDeviceReady(); // Running is the browser

        }

    };

    var onDeviceReady = function() {

        console.log('Received Event: onDeviceReady');

        // Build the main app view
        loadTemplates();

    };

    var templatesReady = function(splash){

        buildSplashScreen(splash);

       // navigator.splashscreen.hide();

    };

    var buildSplashScreen = function(tpl){

        // Inject the template in the view
        var html = mustache.to_html(tpl, appData);
        document.querySelector('div.app').innerHTML = html;

    };

    var loadTemplates = function () {

        require([
            'text!../tpl/splash-tpl.html'
        ], templatesReady);


        console.log(document.paths)

    };

    var initialize = function(data){

        appData = data;
        bindEvents();

    };

    return {

        init: initialize

    };
}));

/**
 * Created with IntelliJ IDEA.
 * User: giorgionatili
 * Date: 11/23/12
 * Time: 12:16 AM
 * To change this template use File | Settings | File Templates.
 */


require.config({

    paths: {
        mustache: 'libs/mustache',
        alice: 'libs/alice.min',
        text: 'libs/require/plugins/text',
        templates: 'tpl'
    },

    waitSeconds: 10

});

require([
    // Load our app module and pass it to our definition function
    'index'
], function(app){

    var appData = {

        appName:        'urTrip',
        appSlogan:      'Plan.Report.Share',
        create:         'create your trip',
        open:           'open an existing trip',
        share:          'share your trip',
        year:           '2012',
        rights:         'All rights reserved',
        developer:      'Giorgio Natili',
        developerSite:  'webplatform.io'

    };

    // The "app" dependency is passed in as "App"
    app.init(appData);
});

define("main", function(){});
