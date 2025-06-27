// ==UserScript==
// @name         U-tools 번역기
// @namespace    Gray
// @version      0.25.6
// @description  작성된 단어 사전으로 일본어 기술명을 번역합니다.
// @author       별구름
// @match        https://*.xn--gck1f423k.xn--1bvt37a.tools/*
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @updateURL    https://raw.githubusercontent.com/bluenebula0528/uma/main/translator.js
// @downloadURL  https://raw.githubusercontent.com/bluenebula0528/uma/main/translator.js
// ==/UserScript==

console.log("Translation script with iframe support running...");

(function () {
    const dictionaryUrl = "https://raw.githubusercontent.com/bluenebula0528/uma/main/dictionary.json";

    // Load external dictionary JSON
    function loadDictionary(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                onload: function (response) {
                    try {
                        const json = JSON.parse(response.responseText);
                        resolve(json);
                    } catch (e) {
                        reject("Failed to parse dictionary JSON: " + e);
                    }
                },
                onerror: function (err) {
                    reject("Failed to load dictionary: " + err);
                }
            });
        });
    }

    // Flatten nested dictionary
    function restructureDictionary(dictionary) {
        let flattened = {};
        Object.keys(dictionary).forEach(key => {
            if (typeof dictionary[key] === 'object') {
                Object.keys(dictionary[key]).forEach(subKey => {
                    flattened[subKey] = dictionary[key][subKey];
                });
            } else {
                flattened[key] = dictionary[key];
            }
        });
        return flattened;
    }

    // Escape special characters for regex
    function escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Build RegExp map (sorted by length descending)
    function buildRegExpMap(flatDictionary) {
        return Object.keys(flatDictionary)
            .sort((a, b) => b.length - a.length)
            .map(jp => ({
                regex: new RegExp(escapeRegExp(jp), "g"),
                replacement: flatDictionary[jp]
            }));
    }

    // Process a single text node
    function processTextNode(node, regExpMap) {
        if (!node.nodeValue.trim()) return; // Skip empty text nodes
        let text = node.nodeValue;
        for (let { regex, replacement } of regExpMap) {
            text = text.replace(regex, replacement);
        }
        node.nodeValue = text;
    }

    // Traverse and replace text in a document or node subtree
    function traverseAndReplace(rootNode, regExpMap) {
        const nodeStack = [rootNode];
        while (nodeStack.length) {
            const currentNode = nodeStack.pop();

            if (currentNode.nodeType === 3) { // Text node
                processTextNode(currentNode, regExpMap);
            } else if (currentNode.nodeType === 1) { // Element node
                // Skip script/style/textarea/iframe/etc
                if (["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "TEXTAREA"].includes(currentNode.tagName)) continue;

                // Handle form element values
                if (currentNode.value) {
                    let value = currentNode.value;
                    for (let { regex, replacement } of regExpMap) {
                        value = value.replace(regex, replacement);
                    }
                    currentNode.value = value;
                }

                // Add child nodes to stack
                for (let i = currentNode.childNodes.length - 1; i >= 0; i--) {
                    nodeStack.push(currentNode.childNodes[i]);
                }
            }
        }
    }

    // Inject translation logic into a given document (top or iframe)
    function injectInto(doc, regExpMap) {
        try {
            traverseAndReplace(doc.body, regExpMap);

            const observer = new MutationObserver(mutations => {
                for (let mutation of mutations) {
                    for (let node of mutation.addedNodes) {
                        if (node.nodeType === 1 || node.nodeType === 3) {
                            setTimeout(() => traverseAndReplace(node, regExpMap), 0);
                        }
                    }
                }
            });

            observer.observe(doc.body, { childList: true, subtree: true });
        } catch (e) {
            console.warn("Failed to inject into iframe:", e);
        }
    }

    // Monitor and translate dynamically added iframes
    function monitorIframes(rootDoc, regExpMap) {
        const frames = Array.from(rootDoc.querySelectorAll('iframe'));
        frames.forEach(iframe => {
            try {
                const idoc = iframe.contentDocument;
                if (idoc && !iframe._translated) {
                    injectInto(idoc, regExpMap);
                    iframe._translated = true; // Prevent duplicate injection
                }
            } catch (e) {
                // Possible CORS-restricted iframe, ignore
            }
        });
    }

    loadDictionary(dictionaryUrl)
        .then(dictionary => {
            console.log("Dictionary loaded successfully.");
            const flatDictionary = restructureDictionary(dictionary);
            const regExpMap = buildRegExpMap(flatDictionary);

            // Apply translation to top document
            injectInto(document, regExpMap);
            monitorIframes(document, regExpMap);

            // Watch for future iframe additions
            const topObserver = new MutationObserver(() => monitorIframes(document, regExpMap));
            topObserver.observe(document.body, { childList: true, subtree: true });
        })
        .catch(err => {
            console.error(err);
        });
})();
