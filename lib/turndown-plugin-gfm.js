/**
 * @joplin/turndown-plugin-gfm v1.0.64
 * Browser-compatible IIFE wrapper
 * Original: https://github.com/laurent22/joplin-turndown-plugin-gfm
 * License: MIT
 */
var turndownPluginGfm = (function () {
  'use strict';

  var highlightRegExp = /highlight-(?:text|source)-([a-z0-9]+)/;

  function highlightedCodeBlock (turndownService) {
    turndownService.addRule('highlightedCodeBlock', {
      filter: function (node) {
        var firstChild = node.firstChild;
        return (
          node.nodeName === 'DIV' &&
          highlightRegExp.test(node.className) &&
          firstChild &&
          firstChild.nodeName === 'PRE'
        )
      },
      replacement: function (content, node, options) {
        var className = node.className || '';
        var language = (className.match(highlightRegExp) || [null, ''])[1];

        return (
          '\n\n' + options.fence + language + '\n' +
          node.firstChild.textContent +
          '\n' + options.fence + '\n\n'
        )
      }
    });
  }

  function strikethrough (turndownService) {
    turndownService.addRule('strikethrough', {
      filter: ['del', 's', 'strike'],
      replacement: function (content) {
        return '~~' + content + '~~'
      }
    });
  }

  var indexOf = Array.prototype.indexOf;
  var every = Array.prototype.every;
  var rules = {};
  var alignMap = { left: ':---', right: '---:', center: ':---:' };

  let isCodeBlock_ = null;
  let options_ = null;

  const tableShouldBeSkippedCache_ = new WeakMap();

  function getAlignment(node) {
    return node ? (node.getAttribute('align') || node.style.textAlign || '').toLowerCase() : '';
  }

  function getBorder(alignment) {
    return alignment ? alignMap[alignment] : '---';
  }

  function getColumnAlignment(table, columnIndex) {
    var votes = {
      left: 0,
      right: 0,
      center: 0,
      '': 0,
    };

    var align = '';

    for (var i = 0; i < table.rows.length; ++i) {
      var row = table.rows[i];
      if (columnIndex < row.childNodes.length) {
        var cellAlignment = getAlignment(row.childNodes[columnIndex]);
        ++votes[cellAlignment];

        if (votes[cellAlignment] > votes[align]) {
          align = cellAlignment;
        }
      }
    }

    return align;
  }

  rules.tableCell = {
    filter: ['th', 'td'],
    replacement: function (content, node) {
      if (tableShouldBeSkipped(nodeParentTable(node))) return content;
      return cell(content, node)
    }
  };

  rules.tableRow = {
    filter: 'tr',
    replacement: function (content, node) {
      const parentTable = nodeParentTable(node);
      if (tableShouldBeSkipped(parentTable)) return content;

      var borderCells = '';

      if (isHeadingRow(node)) {
        const colCount = tableColCount(parentTable);
        for (var i = 0; i < colCount; i++) {
          const childNode = i < node.childNodes.length ? node.childNodes[i] : null;
          var border = getBorder(getColumnAlignment(parentTable, i));
          borderCells += cell(border, childNode, i);
        }
      }
      return '\n' + content + (borderCells ? '\n' + borderCells : '')
    }
  };

  rules.table = {
    filter: function (node, options) {
      return node.nodeName === 'TABLE';
    },

    replacement: function (content, node) {
      if (tableShouldBeHtml(node, options_)) {
        let html = node.outerHTML;
        let divParent = nodeParentDiv(node);
        if (divParent === null || !divParent.classList.contains('joplin-table-wrapper')){
          return '\n\n<div class="joplin-table-wrapper">' + html + '</div>\n\n';
        } else {
          return html
        }
      } else {
        if (tableShouldBeSkipped(node)) return content;

        content = content.replace(/\n+/g, '\n');

        var secondLine = content.trim().split('\n');
        if (secondLine.length >= 2) secondLine = secondLine[1];
        var secondLineIsDivider = /\| :?---/.test(secondLine);

        var columnCount = tableColCount(node);
        var emptyHeader = '';
        if (columnCount && !secondLineIsDivider) {
          emptyHeader = '|' + '     |'.repeat(columnCount) + '\n' + '|';
          for (var columnIndex = 0; columnIndex < columnCount; ++columnIndex) {
            emptyHeader += ' ' + getBorder(getColumnAlignment(node, columnIndex)) + ' |';
          }
        }

        const captionContent = node.caption ? node.caption.textContent || '' : '';
        const caption = captionContent ? captionContent + '\n\n' : '';
        const tableContent = ('' + emptyHeader + content).trimStart();
        return '\n\n' + caption + tableContent + '\n\n';
      }
    }
  };

  rules.tableCaption = {
    filter: ['caption'],
    replacement: function () { return '' },
  };

  rules.tableColgroup = {
    filter: ['colgroup', 'col'],
    replacement: function () { return '' },
  };

  rules.tableSection = {
    filter: ['thead', 'tbody', 'tfoot'],
    replacement: function (content) {
      return content
    }
  };

  function isHeadingRow (tr) {
    var parentNode = tr.parentNode;
    return (
      parentNode.nodeName === 'THEAD' ||
      (
        parentNode.firstChild === tr &&
        (parentNode.nodeName === 'TABLE' || isFirstTbody(parentNode)) &&
        every.call(tr.childNodes, function (n) { return n.nodeName === 'TH' })
      )
    )
  }

  function isFirstTbody (element) {
    var previousSibling = element.previousSibling;
    return (
      element.nodeName === 'TBODY' && (
        !previousSibling ||
        (
          previousSibling.nodeName === 'THEAD' &&
          /^\s*$/i.test(previousSibling.textContent)
        )
      )
    )
  }

  function cell (content, node, index) {
    if (node === undefined) node = null;
    if (index === undefined || index === null) index = indexOf.call(node.parentNode.childNodes, node);
    var prefix = ' ';
    if (index === 0) prefix = '| ';
    var filteredContent = content.trim().replace(/\n\r/g, '<br>').replace(/\n/g, '<br>');
    filteredContent = filteredContent.replace(/\|+/g, '\\|');
    while (filteredContent.length < 3) filteredContent += ' ';
    if (node) filteredContent = handleColSpan(filteredContent, node, ' ');
    return prefix + filteredContent + ' |'
  }

  function nodeContainsTable(node) {
    if (!node.childNodes) return false;

    for (var i = 0; i < node.childNodes.length; i++) {
      var child = node.childNodes[i];
      if (child.nodeName === 'TABLE') return true;
      if (nodeContainsTable(child)) return true;
    }
    return false;
  }

  var nodeContains = function (node, types) {
    if (!node.childNodes) return false;

    for (var i = 0; i < node.childNodes.length; i++) {
      var child = node.childNodes[i];
      if (types === 'code' && isCodeBlock_ && isCodeBlock_(child)) return true;
      if (types.includes(child.nodeName)) return true;
      if (nodeContains(child, types)) return true;
    }

    return false;
  };

  var tableShouldBeHtml = function (tableNode, options) {
    var possibleTags = [
      'UL',
      'OL',
      'H1',
      'H2',
      'H3',
      'H4',
      'H5',
      'H6',
      'HR',
      'BLOCKQUOTE',
    ];

    if (options && options.preserveNestedTables) possibleTags.push('TABLE');

    return nodeContains(tableNode, 'code') ||
      nodeContains(tableNode, possibleTags);
  };

  function tableShouldBeSkipped(tableNode) {
    var cached = tableShouldBeSkippedCache_.get(tableNode);
    if (cached !== undefined) return cached;

    var result = tableShouldBeSkipped_(tableNode);

    tableShouldBeSkippedCache_.set(tableNode, result);
    return result;
  }

  function tableShouldBeSkipped_(tableNode) {
    if (!tableNode) return true;
    if (!tableNode.rows) return true;
    if (tableNode.rows.length === 1 && tableNode.rows[0].childNodes.length <= 1) return true;
    if (nodeContainsTable(tableNode)) return true;
    return false;
  }

  function nodeParentDiv(node) {
    var parent = node.parentNode;
    while (parent.nodeName !== 'DIV') {
      parent = parent.parentNode;
      if (!parent) return null;
    }
    return parent;
  }

  function nodeParentTable(node) {
    var parent = node.parentNode;
    while (parent.nodeName !== 'TABLE') {
      parent = parent.parentNode;
      if (!parent) return null;
    }
    return parent;
  }

  function handleColSpan(content, node, emptyChar) {
    var colspan = node.getAttribute('colspan') || 1;
    for (var i = 1; i < colspan; i++) {
      content += ' | ' + emptyChar.repeat(3);
    }
    return content
  }

  function tableColCount(node) {
    var maxColCount = 0;
    for (var i = 0; i < node.rows.length; i++) {
      var row = node.rows[i];
      var colCount = row.childNodes.length;
      if (colCount > maxColCount) maxColCount = colCount;
    }
    return maxColCount
  }

  function tables (turndownService) {
    isCodeBlock_ = turndownService.isCodeBlock;
    options_ = turndownService.options;

    turndownService.keep(function (node) {
      if (node.nodeName === 'TABLE' && tableShouldBeHtml(node, turndownService.options)) return true;
      return false;
    });
    for (var key in rules) turndownService.addRule(key, rules[key]);
  }

  function taskListItems (turndownService) {
    turndownService.addRule('taskListItems', {
      filter: function (node) {
        var parent = node.parentNode;
        var grandparent = parent.parentNode;
        return node.type === 'checkbox' && (
          parent.nodeName === 'LI'
          || (parent.nodeName === 'LABEL' && grandparent && grandparent.nodeName === 'LI')
        )
      },
      replacement: function (content, node) {
        return (node.checked ? '[x]' : '[ ]') + ' '
      }
    });
  }

  function gfm (turndownService) {
    turndownService.use([
      highlightedCodeBlock,
      strikethrough,
      tables,
      taskListItems
    ]);
  }

  return {
    gfm: gfm,
    highlightedCodeBlock: highlightedCodeBlock,
    strikethrough: strikethrough,
    tables: tables,
    taskListItems: taskListItems
  };
})();
