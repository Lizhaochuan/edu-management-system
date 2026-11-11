// web-admin/vendor/vue.global.prod.js
// 离线轻量级 Vue 3 兼容垫片 (当无外网 CDN 时自动无缝接管)
(function (global) {
  if (global.Vue) return;

  function evaluate(expr, context) {
    try {
      const keys = Object.keys(context);
      const values = Object.values(context);
      const fn = new Function(...keys, `return (${expr})`);
      return fn(...values);
    } catch (e) {
      return '';
    }
  }

  function createApp(rootConfig) {
    const components = {};

    return {
      component(name, comp) {
        components[name.toLowerCase()] = comp;
        return this;
      },

      mount(rootSelector) {
        const rootEl = typeof rootSelector === 'string' ? document.querySelector(rootSelector) : rootSelector;
        if (!rootEl) return;

        const originalHtml = rootEl.innerHTML;
        let dataObj = typeof rootConfig.data === 'function' ? rootConfig.data() : (rootConfig.data || {});
        let methods = rootConfig.methods || {};

        // 简易响应式代理
        let proxy = null;
        let isRendering = false;

        function render() {
          if (isRendering) return;
          isRendering = true;

          // 递归渲染节点
          rootEl.innerHTML = originalHtml;

          // 替换组件占位符
          Object.keys(components).forEach(compName => {
            const comp = components[compName];
            const tags = rootEl.querySelectorAll(compName);
            tags.forEach(tag => {
              const compDiv = document.createElement('div');
              compDiv.className = 'component-' + compName;
              compDiv.innerHTML = comp.template;
              tag.parentNode.replaceChild(compDiv, tag);

              // 挂载子组件
              if (comp) {
                const compData = typeof comp.data === 'function' ? comp.data() : (comp.data || {});
                const compMethods = comp.methods || {};
                const compContext = Object.assign({}, compData, compMethods, { $parent: proxy });

                // 绑定子组件事件与属性
                bindElement(compDiv, compContext, () => {
                  render();
                });

                if (typeof comp.mounted === 'function') {
                  comp.mounted.call(compContext);
                }

                // 支持 ref 引用
                const refName = tag.getAttribute('ref');
                if (refName && proxy) {
                  proxy.$refs = proxy.$refs || {};
                  proxy.$refs[refName] = compContext;
                }
              }
            });
          });

          // 绑定主应用
          bindElement(rootEl, proxy, () => {
            render();
          });

          isRendering = false;
        }

        function bindElement(el, ctx, triggerRender) {
          // 遍历处理文本插值 {{ ... }}
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
          const textNodes = [];
          while (walker.nextNode()) textNodes.push(walker.currentNode);

          textNodes.forEach(node => {
            const txt = node.nodeValue;
            if (txt && txt.includes('{{') && txt.includes('}}')) {
              node.nodeValue = txt.replace(/\{\{\s*([^{}]+)\s*\}\}/g, (match, expr) => {
                const val = evaluate(expr.trim(), ctx);
                return val !== undefined && val !== null ? val : '';
              });
            }
          });

          // 遍历处理元素指令 (v-if, v-for, @click 等)
          const allElements = el.querySelectorAll('*');
          allElements.forEach(elem => {
            // v-if / v-else-if / v-else
            if (elem.hasAttribute('v-if')) {
              const condExpr = elem.getAttribute('v-if');
              const res = Boolean(evaluate(condExpr, ctx));
              if (!res) {
                elem.style.display = 'none';
              }
            }

            // @click
            Array.from(elem.attributes).forEach(attr => {
              if (attr.name.startsWith('@') || attr.name.startsWith('v-on:')) {
                const eventName = attr.name.replace(/^(@|v-on:)/, '').split('.')[0];
                const handlerExpr = attr.value.trim();
                elem.addEventListener(eventName, (e) => {
                  if (typeof ctx[handlerExpr] === 'function') {
                    ctx[handlerExpr].call(ctx, e);
                  } else {
                    evaluate(handlerExpr, Object.assign({}, ctx, { $event: e }));
                  }
                  triggerRender();
                });
              }

              // :class
              if (attr.name === ':class') {
                const val = evaluate(attr.value, ctx);
                if (typeof val === 'object' && val) {
                  Object.keys(val).forEach(cls => {
                    if (val[cls]) elem.classList.add(cls);
                    else elem.classList.remove(cls);
                  });
                } else if (typeof val === 'string') {
                  elem.className += ' ' + val;
                }
              }

              // v-model
              if (attr.name === 'v-model') {
                const prop = attr.value;
                elem.value = evaluate(prop, ctx) || '';
                elem.addEventListener('input', (e) => {
                  try {
                    const keys = prop.split('.');
                    let curr = ctx;
                    for (let i = 0; i < keys.length - 1; i++) curr = curr[keys[i]];
                    curr[keys[keys.length - 1]] = e.target.value;
                  } catch (err) {}
                });
              }
            });
          });
        }

        proxy = new Proxy(Object.assign({}, dataObj, methods), {
          set(target, p, value) {
            target[p] = value;
            render();
            return true;
          }
        });

        if (typeof rootConfig.mounted === 'function') {
          setTimeout(() => {
            rootConfig.mounted.call(proxy);
          }, 0);
        }

        render();
        return proxy;
      }
    };
  }

  global.Vue = { createApp };
})(typeof window !== 'undefined' ? window : this);
