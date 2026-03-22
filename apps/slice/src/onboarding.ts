export type OnboardingStep =
  | 'welcome'           // Show welcome screen
  | 'api-key-check'     // Verify OpenRouter connection
  | 'model-selection'   // Show/confirm model choices
  | 'workspace-setup'   // Create workspace (channels, director)
  | 'first-task'        // Prompt user to create their first task
  | 'complete';         // Onboarding done

export interface OnboardingState {
  currentStep: OnboardingStep;
  completedSteps: OnboardingStep[];
  apiKeyValid: boolean;
  modelsAvailable: number;
  selectedModels: { director: string; worker: string; steward: string };
  workspaceName?: string;
}

const STEP_ORDER: OnboardingStep[] = [
  'welcome',
  'api-key-check',
  'model-selection',
  'workspace-setup',
  'first-task',
  'complete',
];

export function getInitialState(): OnboardingState {
  return {
    currentStep: 'welcome',
    completedSteps: [],
    apiKeyValid: false,
    modelsAvailable: 0,
    selectedModels: {
      director: 'anthropic/claude-sonnet-4',
      worker: 'anthropic/claude-sonnet-4',
      steward: 'anthropic/claude-haiku',
    },
  };
}

export function getNextStep(state: OnboardingState): OnboardingStep {
  const currentIndex = STEP_ORDER.indexOf(state.currentStep);
  if (currentIndex < 0 || currentIndex >= STEP_ORDER.length - 1) {
    return 'complete';
  }
  return STEP_ORDER[currentIndex + 1];
}

export function isOnboardingComplete(state: OnboardingState): boolean {
  return state.currentStep === 'complete';
}
