// Simpler in-memory conversation form service
// One form per conversationId (Map-backed)

const store = new Map(); // conversationId -> { status, data, submittedAt, processing, initiatedBy }

// Auto-expire forms after 30 minutes
const TTL_MS = 30 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [cid, doc] of store.entries()) {
    if (!doc.submittedAt) continue;
    if (new Date(doc.submittedAt).getTime() < cutoff) store.delete(cid);
  }
}, 60 * 1000);

export async function saveForm(conversationId, formObj = {}) {
  try {
    const doc = {
      status: formObj.status || 'form_submitted',
      data: formObj.data || {},
      submittedAt: formObj.submittedAt ? new Date(formObj.submittedAt).toISOString() : new Date().toISOString(),
      processing: !!formObj.processing,
      initiatedBy: formObj.initiatedBy || null,
    };
    store.set(conversationId, doc);
    return doc;
  } catch (err) {
    console.error('saveForm error (simple in-memory):', err?.message || err);
    throw err;
  }
}

export async function getForm(conversationId) {
  try {
    return store.get(conversationId) || null;
  } catch (err) {
    console.error('getForm error (simple in-memory):', err?.message || err);
    throw err;
  }
}

export async function deleteForm(conversationId) {
  try {
    store.delete(conversationId);
    return true;
  } catch (err) {
    console.error('deleteForm error (simple in-memory):', err?.message || err);
    return false;
  }
}

export async function setProcessing(conversationId, processing = false) {
  try {
    const doc = store.get(conversationId);
    if (!doc) return null;
    doc.processing = processing;
    store.set(conversationId, doc);
    return doc;
  } catch (err) {
    console.error('setProcessing error (simple in-memory):', err?.message || err);
    return null;
  }
}

export default {
  saveForm,
  getForm,
  deleteForm,
  setProcessing,
};
