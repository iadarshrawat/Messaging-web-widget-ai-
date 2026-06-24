import mongoose from 'mongoose';

const ConversationFormSchema = new mongoose.Schema(
  {
    conversationId: { type: String, required: true, unique: true, index: true },
    status: { type: String, default: 'pending_form' },
    initiatedBy: { type: String },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    submittedAt: { type: Date },
    processing: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const ConversationForm = mongoose.models.ConversationForm || mongoose.model('ConversationForm', ConversationFormSchema);

export async function saveForm(conversationId, formObj = {}) {
  try {
    const update = {
      ...formObj,
    };
    const opts = { upsert: true, new: true, setDefaultsOnInsert: true };
    const res = await ConversationForm.findOneAndUpdate({ conversationId }, update, opts).lean();
    return res;
  } catch (err) {
    console.error('saveForm error:', err.message);
    throw err;
  }
}

export async function getForm(conversationId) {
  try {
    const res = await ConversationForm.findOne({ conversationId }).lean();
    return res || null;
  } catch (err) {
    console.error('getForm error:', err.message);
    throw err;
  }
}

export async function deleteForm(conversationId) {
  try {
    await ConversationForm.deleteOne({ conversationId });
    return true;
  } catch (err) {
    console.error('deleteForm error:', err.message);
    return false;
  }
}

export async function setProcessing(conversationId, processing = false) {
  try {
    const res = await ConversationForm.findOneAndUpdate(
      { conversationId },
      { processing },
      { new: true }
    ).lean();
    return res;
  } catch (err) {
    console.error('setProcessing error:', err.message);
    return null;
  }
}

export default ConversationForm;
