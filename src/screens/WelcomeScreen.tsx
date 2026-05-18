// src/screens/WelcomeScreen.tsx
// Écran d'accueil - Design professionnel et épuré
// v2.0 - Sans emojis, typographie élégante

import { useState, useRef, useEffect } from 'react';
import { View, Text, Dimensions, TouchableOpacity, Image, Animated, FlatList, Platform, StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useThemedStyles, type ColorPalette } from '../components/ui';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// ============================================
// TYPES
// ============================================

interface WelcomeScreenProps {
  onComplete: () => void;
}

// Le contenu textuel des slides est chargé via i18n au render. On garde
// uniquement la structure (id, isHero, icônes) statique car celle-ci ne
// dépend pas de la langue.
interface SlideStruct {
  id: string;
  isHero?: boolean;
  // Pour les feature slides : clés i18n des features avec leurs icônes.
  features?: { icon: string; textKey: string }[];
  titleKey?: string;
  subtitleKey?: string;
}

const SLIDE_STRUCTS: SlideStruct[] = [
  {
    id: '1',
    isHero: true,
  },
  {
    id: '2',
    titleKey: 'welcome.slides.encryption.title',
    subtitleKey: 'welcome.slides.encryption.subtitle',
    features: [
      { icon: '📱', textKey: 'welcome.slides.encryption.feature1' },
      { icon: '🚫', textKey: 'welcome.slides.encryption.feature2' },
      { icon: '🔑', textKey: 'welcome.slides.encryption.feature3' },
    ],
  },
  {
    id: '3',
    titleKey: 'welcome.slides.advanced.title',
    subtitleKey: 'welcome.slides.advanced.subtitle',
    features: [
      { icon: '🔄', textKey: 'welcome.slides.advanced.feature1' },
      { icon: '👻', textKey: 'welcome.slides.advanced.feature2' },
      { icon: '🛡️', textKey: 'welcome.slides.advanced.feature3' },
    ],
  },
];

// ============================================
// HERO SLIDE
// ============================================

interface HeroSlideProps {
  isActive: boolean;
}

const HeroSlide = ({ isActive }: HeroSlideProps) => {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const logoFloat = useRef(new Animated.Value(0)).current;
  const logoScale = useRef(new Animated.Value(0.8)).current;
  const logoOpacity = useRef(new Animated.Value(0)).current;
  const titleOpacity = useRef(new Animated.Value(0)).current;
  const titleTranslate = useRef(new Animated.Value(20)).current;
  const subtitleOpacity = useRef(new Animated.Value(0)).current;
  const taglineOpacity = useRef(new Animated.Value(0)).current;
  
  useEffect(() => {
    // Float animation
    const floatAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(logoFloat, {
          toValue: -6,
          duration: 2000,
          useNativeDriver: true,
        }),
        Animated.timing(logoFloat, {
          toValue: 0,
          duration: 2000,
          useNativeDriver: true,
        }),
      ])
    );
    floatAnimation.start();
    return () => floatAnimation.stop();
  }, []);
  
  useEffect(() => {
    if (isActive) {
      Animated.sequence([
        Animated.parallel([
          Animated.spring(logoScale, {
            toValue: 1,
            tension: 50,
            friction: 8,
            useNativeDriver: true,
          }),
          Animated.timing(logoOpacity, {
            toValue: 1,
            duration: 500,
            useNativeDriver: true,
          }),
        ]),
        Animated.parallel([
          Animated.timing(titleOpacity, { toValue: 1, duration: 400, useNativeDriver: true }),
          Animated.timing(titleTranslate, { toValue: 0, duration: 400, useNativeDriver: true }),
        ]),
        Animated.timing(subtitleOpacity, { toValue: 1, duration: 400, useNativeDriver: true }),
        Animated.timing(taglineOpacity, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]).start();
    }
  }, [isActive]);
  
  return (
    <View style={styles.slide}>
      <View style={styles.heroContent}>
        {/* Logo */}
        <Animated.View
          style={[
            styles.logoContainer,
            {
              opacity: logoOpacity,
              transform: [{ translateY: logoFloat }, { scale: logoScale }],
            },
          ]}
        >
          <Image
            source={require('../../assets/icon_nobg.png')}
            style={styles.heroLogo}
          />
        </Animated.View>
        
        {/* Title */}
        <Animated.Text
          style={[
            styles.heroTitle,
            { opacity: titleOpacity, transform: [{ translateY: titleTranslate }] },
          ]}
        >
          {t('welcome.slides.hero.title')}
        </Animated.Text>
        
        {/* Subtitle */}
        <Animated.Text style={[styles.heroSubtitle, { opacity: subtitleOpacity }]}>
          {t('welcome.slides.hero.subtitle')}
        </Animated.Text>
        
        {/* Tagline */}
        <Animated.View style={[styles.taglineRow, { opacity: taglineOpacity }]}>
          <View style={styles.taglineLine} />
          <Text style={styles.taglineText}>{t('welcome.tagline')}</Text>
          <View style={styles.taglineLine} />
        </Animated.View>
      </View>
    </View>
  );
};

// ============================================
// FEATURE SLIDE
// ============================================

interface FeatureSlideProps {
  data: SlideStruct;
  isActive: boolean;
}

const FeatureSlide = ({ data, isActive }: FeatureSlideProps) => {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;
  
  useEffect(() => {
    if (isActive) {
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }),
        Animated.timing(slideAnim, { toValue: 0, duration: 400, useNativeDriver: true }),
      ]).start();
    } else {
      fadeAnim.setValue(0);
      slideAnim.setValue(30);
    }
  }, [isActive]);
  
  return (
    <View style={styles.slide}>
      <Animated.View
        style={[
          styles.featureContent,
          { opacity: fadeAnim, transform: [{ translateY: slideAnim }] },
        ]}
      >
        {/* Title */}
        {data.titleKey && <Text style={styles.featureTitle}>{t(data.titleKey as any)}</Text>}
        
        {/* Subtitle */}
        {data.subtitleKey && <Text style={styles.featureSubtitle}>{t(data.subtitleKey as any)}</Text>}
        
        {/* Features list */}
        {data.features && (
          <View style={styles.featuresList}>
            {data.features.map((feature, i) => (
              <View key={i} style={styles.featureItem}>
                <View style={styles.featureIconContainer}>
                  <Text style={styles.featureEmoji}>{feature.icon}</Text>
                </View>
                <Text style={styles.featureText}>{t(feature.textKey as any)}</Text>
              </View>
            ))}
          </View>
        )}
      </Animated.View>
    </View>
  );
};

// ============================================
// PAGINATION
// ============================================

const Pagination = ({ currentIndex, total }: { currentIndex: number; total: number }) => {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.pagination}>
      {Array.from({ length: total }).map((_, i) => (
        <View key={i} style={[styles.dot, i === currentIndex && styles.dotActive]} />
      ))}
    </View>
  );
};

// ============================================
// MAIN COMPONENT
// ============================================

export function WelcomeScreen({ onComplete }: WelcomeScreenProps) {
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const flatListRef = useRef<FlatList>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const buttonFade = useRef(new Animated.Value(0)).current;
  
  useEffect(() => {
    Animated.timing(buttonFade, {
      toValue: 1,
      duration: 800,
      delay: 300,
      useNativeDriver: true,
    }).start();
  }, []);
  
  const handleScroll = (event: any) => {
    const index = Math.round(event.nativeEvent.contentOffset.x / SCREEN_WIDTH);
    setCurrentIndex(index);
  };
  
  const handleNext = () => {
    if (currentIndex < SLIDE_STRUCTS.length - 1) {
      flatListRef.current?.scrollToIndex({ index: currentIndex + 1, animated: true });
    } else {
      onComplete();
    }
  };
  
  const isLastSlide = currentIndex === SLIDE_STRUCTS.length - 1;
  
  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
      
      {/* Skip */}
      {!isLastSlide && (
        <Animated.View style={[styles.skipContainer, { top: insets.top + 16, opacity: buttonFade }]}>
          <TouchableOpacity onPress={onComplete} style={styles.skipButton}>
            <Text
              style={styles.skipText}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.85}
            >
              {t('welcome.skip')}
            </Text>
          </TouchableOpacity>
        </Animated.View>
      )}
      
      {/* Slides */}
      <FlatList
        ref={flatListRef}
        data={SLIDE_STRUCTS}
        renderItem={({ item, index }) =>
          item.isHero ? (
            <HeroSlide isActive={index === currentIndex} />
          ) : (
            <FeatureSlide data={item} isActive={index === currentIndex} />
          )
        }
        keyExtractor={(item) => item.id}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={handleScroll}
        bounces={false}
      />
      
      {/* Bottom */}
      <Animated.View style={[styles.bottom, { paddingBottom: insets.bottom + 24, opacity: buttonFade }]}>
        <Pagination currentIndex={currentIndex} total={SLIDE_STRUCTS.length} />
        
        <TouchableOpacity onPress={handleNext} style={styles.button} activeOpacity={0.8}>
          <Text
            style={styles.buttonText}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.82}
          >
            {isLastSlide ? t('welcome.start') : t('welcome.next')}
          </Text>
        </TouchableOpacity>

        <Text style={styles.techNote}>{t('welcome.techNote')}</Text>
      </Animated.View>
    </View>
  );
}

// ============================================
// STYLES
// ============================================

const makeStyles = (colors: ColorPalette) => ({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  
  // Skip
  skipContainer: {
    position: 'absolute',
    right: 20,
    zIndex: 10,
  },
  skipButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  skipText: {
    fontSize: 15,
    color: colors.textMuted,
    fontWeight: '500',
  },
  
  // Slides
  slide: {
    width: SCREEN_WIDTH,
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  
  // Hero
  heroContent: {
    alignItems: 'center',
  },
  logoContainer: {
    width: 120,
    height: 120,
    marginBottom: 32,
  },
  heroLogo: {
    width: 120,
    height: 120,
    borderRadius: 28,
  },
  heroTitle: {
    fontSize: 44,
    fontWeight: '700',
    color: colors.text,
    letterSpacing: -1.5,
    marginBottom: 20,
  },
  heroSubtitle: {
    fontSize: 26,
    fontWeight: '300',
    color: colors.text,
    textAlign: 'center',
    lineHeight: 36,
    opacity: 0.9,
  },
  taglineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 40,
    gap: 16,
  },
  taglineLine: {
    width: 24,
    height: 1,
    backgroundColor: colors.textMuted,
    opacity: 0.4,
  },
  taglineText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    letterSpacing: 2,
  },
  
  // Feature slides
  featureContent: {
    alignItems: 'center',
    width: '100%',
  },
  featureTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
    marginBottom: 12,
    letterSpacing: -0.5,
  },
  featureSubtitle: {
    fontSize: 16,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 40,
  },
  featuresList: {
    width: '100%',
    gap: 12,
  },
  featureItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 16,
    // ════════════════════════════════════════════════════════════════════
    // STABILITÉ I18N — hauteur minimale
    // ════════════════════════════════════════════════════════════════════
    // Sur DE/RU/AR, certaines features ont des chaînes ~50% plus longues
    // qu'en EN, ce qui fait wrapper le texte sur 2 lignes. Sans minHeight,
    // les 3 cellules de la liste ont alors des hauteurs différentes →
    // alignement visuel cassé. Avec minHeight=76, on garantit une cellule
    // qui accueille proprement 1 OU 2 lignes de texte, et les 3 features
    // ont la même empreinte verticale quelle que soit la langue.
    // ════════════════════════════════════════════════════════════════════
    minHeight: 76,
  },
  featureIconContainer: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
    // Empêche l'icône d'être compressée si le texte adjacent est long
    flexShrink: 0,
  },
  featureEmoji: {
    fontSize: 20,
  },
  featureText: {
    flex: 1,
    fontSize: 15,
    color: colors.text,
    fontWeight: '500',
    lineHeight: 20,
  },
  
  // Bottom
  bottom: {
    paddingHorizontal: 32,
    alignItems: 'center',
  },
  pagination: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 24,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.surface,
  },
  dotActive: {
    width: 24,
    backgroundColor: colors.primary,
  },
  button: {
    width: '100%',
    paddingVertical: 16,
    backgroundColor: colors.primary,
    borderRadius: 12,
    alignItems: 'center',
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  techNote: {
    marginTop: 16,
    fontSize: 10,
    color: colors.textMuted,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    letterSpacing: 0.3,
    opacity: 0.5,
  },
}) as const;

export default WelcomeScreen;