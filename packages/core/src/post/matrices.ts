// Standard sepia transformation matrix
export const SEPIA_MATRIX = new Float32Array([
  0.393,
  0.769,
  0.189, // Red output
  0.349,
  0.686,
  0.168, // Green output
  0.272,
  0.534,
  0.131, // Blue output
])

/**
 * Colorblindness simulation and compensation filters using color matrix transformations.
 */

// Protanopia (Red-blind) simulation matrix - shows how colors appear to someone with red-blindness
export const PROTANOPIA_SIM_MATRIX = new Float32Array([
  0.567,
  0.433,
  0.0, // Red output
  0.558,
  0.442,
  0.0, // Green output
  0.0,
  0.242,
  0.758, // Blue output
])

// Deuteranopia (Green-blind) simulation matrix - shows how colors appear to someone with green-blindness
export const DEUTERANOPIA_SIM_MATRIX = new Float32Array([
  0.625,
  0.375,
  0.0, // Red output
  0.7,
  0.3,
  0.0, // Green output
  0.0,
  0.3,
  0.7, // Blue output
])

// Tritanopia (Blue-blind) simulation matrix - shows how colors appear to someone with blue-blindness
export const TRITANOPIA_SIM_MATRIX = new Float32Array([
  0.95,
  0.05,
  0.0, // Red output
  0.0,
  0.433,
  0.567, // Green output
  0.0,
  0.475,
  0.525, // Blue output
])

// Achromatopsia (Complete color blindness) - grayscale
export const ACHROMATOPSIA_MATRIX = new Float32Array([
  0.299,
  0.587,
  0.114, // Red output (luminance)
  0.299,
  0.587,
  0.114, // Green output (luminance)
  0.299,
  0.587,
  0.114, // Blue output (luminance)
])

// Protanopia compensation matrix - shifts colors to make them more distinguishable
export const PROTANOPIA_COMP_MATRIX = new Float32Array([
  1.0,
  0.2,
  0.0, // Boost red channel
  0.0,
  0.9,
  0.1, // Adjust green
  0.0,
  0.1,
  0.9, // Enhance blue
])

// Deuteranopia compensation matrix - shifts colors to make them more distinguishable
export const DEUTERANOPIA_COMP_MATRIX = new Float32Array([
  0.9,
  0.1,
  0.0, // Adjust red
  0.2,
  0.8,
  0.0, // Boost green channel
  0.0,
  0.0,
  1.0, // Keep blue
])

// Tritanopia compensation matrix - shifts colors to make them more distinguishable
export const TRITANOPIA_COMP_MATRIX = new Float32Array([
  1.0,
  0.0,
  0.0, // Keep red
  0.0,
  0.9,
  0.1, // Adjust green
  0.1,
  0.0,
  0.9, // Boost blue channel
])

/**
 * Creative color effect matrices.
 */

// Technicolor effect - enhances reds and greens for a vintage Hollywood look
export const TECHNICOLOR_MATRIX = new Float32Array([
  1.5,
  -0.2,
  -0.3, // Red output - boosted with reduced green/blue influence
  -0.3,
  1.4,
  -0.1, // Green output - boosted with reduced red/blue influence
  -0.2,
  -0.2,
  1.4, // Blue output - slightly boosted
])

// Solarization effect - partial negative that creates a surreal look
// Inverts blue channel strongly, partially inverts others
export const SOLARIZATION_MATRIX = new Float32Array([
  -0.5,
  0.5,
  0.5, // Red output - partial negative
  0.5,
  -0.5,
  0.5, // Green output - partial negative
  0.5,
  0.5,
  -0.5, // Blue output - partial negative
])

