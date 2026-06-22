import { useRef, useState, useEffect, useCallback } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { renderMarkdown } from '../../utils/markdown';
import { useMermaidDiagrams } from '../../hooks/use-mermaid-diagrams';
import { Overlay } from '../../ui';
import styles from '../Settings.module.css';

export function CompiledMemoryViewer() {
  const [visible, setVisible] = useState(false);
  const [content, setContent] = useState('');
  const [editableFactsEnabled, setEditableFactsEnabled] = useState(false);
  const [sections, setSections] = useState({ facts: '', today: '', week: '', longterm: '' });
  const [factsDraft, setFactsDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [savingFacts, setSavingFacts] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  useMermaidDiagrams(contentRef, [content, sections, loading]);

  useEffect(() => {
    const handler = () => { setVisible(true); load(); };
    window.addEventListener('hana-view-compiled-memory', handler);
    return () => window.removeEventListener('hana-view-compiled-memory', handler);
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const aid = useSettingsStore.getState().getSettingsAgentId();
      const res = await hanaFetch(`/api/memories/compiled?agentId=${aid}`);
      const data = await res.json();
      setContent(data.content || '');
      const nextSections = {
        facts: data.sections?.facts || '',
        today: data.sections?.today || '',
        week: data.sections?.week || '',
        longterm: data.sections?.longterm || '',
      };
      setEditableFactsEnabled(data.editableFactsEnabled === true);
      setSections(nextSections);
      setFactsDraft(nextSections.facts);
    } catch (err: any) {
      setContent(`Error: ${err.message}`);
      setEditableFactsEnabled(false);
      setSections({ facts: '', today: '', week: '', longterm: '' });
      setFactsDraft('');
    } finally {
      setLoading(false);
    }
  };

  const clearCompiled = async () => {
    try {
      const aid = useSettingsStore.getState().getSettingsAgentId();
      await hanaFetch(`/api/memories/compiled?agentId=${aid}`, { method: 'DELETE' });
      setContent('');
      setSections(prev => (
        editableFactsEnabled
          ? { ...prev, today: '', week: '', longterm: '' }
          : { facts: '', today: '', week: '', longterm: '' }
      ));
      useSettingsStore.getState().showToast(t('settings.memory.compiledCleared'), 'success');
    } catch (err: any) {
      useSettingsStore.getState().showToast(err.message, 'error');
    }
  };

  const saveFacts = async () => {
    setSavingFacts(true);
    try {
      const aid = useSettingsStore.getState().getSettingsAgentId();
      const res = await hanaFetch(`/api/memories/compiled/facts?agentId=${aid}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facts: factsDraft }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const savedFacts = typeof data.facts === 'string' ? data.facts : factsDraft;
      setFactsDraft(savedFacts);
      setSections(prev => ({ ...prev, facts: savedFacts }));
      useSettingsStore.getState().showToast(t('settings.memory.factsSaved'), 'success');
    } catch (err: any) {
      useSettingsStore.getState().showToast(err.message, 'error');
    } finally {
      setSavingFacts(false);
    }
  };

  const close = useCallback(() => setVisible(false), []);
  const readonlyBlocks = [
    { key: 'today', title: t('settings.memory.sections.today'), value: sections.today },
    { key: 'week', title: t('settings.memory.sections.week'), value: sections.week },
    { key: 'longterm', title: t('settings.memory.sections.longterm'), value: sections.longterm },
  ];

  return (
    <Overlay
      open={visible}
      onClose={close}
      backdrop="blur"
      zIndex={100}
      className={styles['memory-viewer']}
      backdropClassName={styles['memory-viewer-backdrop']}
      disableContainerAnimation
    >
        <div className={styles['memory-viewer-header']}>
          <h3 className={styles['memory-viewer-title']}>{t('settings.memory.compiled')}</h3>
          <div className={styles['memory-viewer-header-actions']}>
            <button className={styles['compiled-clear-btn']} onClick={clearCompiled}>
              {t('settings.memory.compiledClear')}
            </button>
            <button className={styles['memory-viewer-close']} onClick={close}>✕</button>
          </div>
        </div>
        <div className={`${styles['memory-viewer-body']} ${styles['compiled-memory-body']}`}>
          {loading ? (
            <div className="memory-viewer-empty">Loading...</div>
          ) : editableFactsEnabled ? (
            <div className={styles['compiled-memory-editable']}>
              <label className={styles['compiled-memory-editor-label']} htmlFor="compiled-memory-facts-editor">
                {t('settings.memory.editableFactsLabel')}
              </label>
              <textarea
                id="compiled-memory-facts-editor"
                className={styles['compiled-memory-facts-editor']}
                value={factsDraft}
                onChange={(event) => setFactsDraft(event.target.value)}
                disabled={savingFacts}
              />
              <div className={styles['compiled-memory-editor-actions']}>
                <button
                  type="button"
                  className={styles['compiled-memory-save-btn']}
                  onClick={saveFacts}
                  disabled={savingFacts}
                >
                  {t('settings.memory.saveFacts')}
                </button>
              </div>
              <div className={styles['compiled-memory-readonly-title']}>
                {t('settings.memory.readonlyTimelineTitle')}
              </div>
              <div ref={contentRef} className={styles['compiled-memory-readonly-list']}>
                {readonlyBlocks.map(block => (
                  <section className={styles['compiled-memory-readonly-block']} key={block.key}>
                    <h4>{block.title}</h4>
                    {block.value.trim() ? (
                      <div
                        className={`${styles['compiled-memory-md']} ${'md-content'}`}
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(block.value) }}
                      />
                    ) : (
                      <div className="memory-viewer-empty">{t('settings.memory.compiledEmpty')}</div>
                    )}
                  </section>
                ))}
              </div>
            </div>
          ) : content.trim() ? (
            <div
              ref={contentRef}
              className={`${styles['compiled-memory-md']} ${'md-content'}`}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
            />
          ) : (
            <div className="memory-viewer-empty">{t('settings.memory.compiledEmpty')}</div>
          )}
        </div>
    </Overlay>
  );
}
